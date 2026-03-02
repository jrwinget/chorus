import { describe, it, expect } from 'vitest';
import {
  CalibrationDataPoint,
  CalibrationCurvePoint,
  calculateBrierScore,
  getCalibrationCurve,
  generateInsights,
  calculateCalibrationMetrics,
  formatCalibrationChart,
} from './calibration';

// helper to create a data point with defaults
function point(confidence: number, outcome: boolean, extra?: Partial<CalibrationDataPoint>): CalibrationDataPoint {
  return { confidence, outcome, ...extra };
}

describe('calibration', () => {
  // -- calculateBrierScore ---------------------------------------------------

  describe('calculateBrierScore', () => {
    it('should return 0 for an empty array', () => {
      expect(calculateBrierScore([])).toBe(0);
    });

    it('should return 0 for a perfect prediction (confidence 5, outcome true)', () => {
      // forecast = 5/5 = 1, outcome = 1, error = 0
      const data = [point(5, true)];
      expect(calculateBrierScore(data)).toBe(0);
    });

    it('should return 0 for a perfect low-confidence prediction (confidence 0, outcome false)', () => {
      // forecast = 0/5 = 0, outcome = 0, error = 0
      // note: confidence 0 is outside the stated 1-5 scale but the function handles it
      const data = [{ confidence: 0, outcome: false }];
      expect(calculateBrierScore(data)).toBe(0);
    });

    it('should return 1 for the worst possible prediction (confidence 5, outcome false)', () => {
      // forecast = 1, outcome = 0, error = 1, squared = 1
      const data = [point(5, false)];
      expect(calculateBrierScore(data)).toBe(1);
    });

    it('should return 1 for the worst inverse prediction (confidence 0, outcome true)', () => {
      // forecast = 0, outcome = 1, error = -1, squared = 1
      const data = [{ confidence: 0, outcome: true }];
      expect(calculateBrierScore(data)).toBe(1);
    });

    it('should calculate correctly for a single mid-range prediction', () => {
      // forecast = 3/5 = 0.6, outcome = 1, error = -0.4, squared = 0.16
      const data = [point(3, true)];
      expect(calculateBrierScore(data)).toBeCloseTo(0.16, 10);
    });

    it('should average scores across multiple predictions', () => {
      // point 1: forecast=5/5=1, outcome=1, err=0, sq=0
      // point 2: forecast=1/5=0.2, outcome=0, err=0.2, sq=0.04
      // average = (0 + 0.04) / 2 = 0.02
      const data = [point(5, true), point(1, false)];
      expect(calculateBrierScore(data)).toBeCloseTo(0.02, 10);
    });

    it('should handle all confidence levels on the 1-5 scale', () => {
      // all predictions are successful
      // forecast = c/5, outcome = 1, error = (c/5 - 1)
      // brier = (1/5) * sum((c/5 - 1)^2) for c = 1..5
      // = (1/5) * ((0.2-1)^2 + (0.4-1)^2 + (0.6-1)^2 + (0.8-1)^2 + (1-1)^2)
      // = (1/5) * (0.64 + 0.36 + 0.16 + 0.04 + 0)
      // = (1/5) * 1.2 = 0.24
      const data = [
        point(1, true),
        point(2, true),
        point(3, true),
        point(4, true),
        point(5, true),
      ];
      expect(calculateBrierScore(data)).toBeCloseTo(0.24, 10);
    });

    it('should handle mixed outcomes', () => {
      // point 1: forecast=4/5=0.8, outcome=1, err=-0.2, sq=0.04
      // point 2: forecast=4/5=0.8, outcome=0, err=0.8, sq=0.64
      // point 3: forecast=2/5=0.4, outcome=0, err=0.4, sq=0.16
      // point 4: forecast=2/5=0.4, outcome=1, err=-0.6, sq=0.36
      // average = (0.04 + 0.64 + 0.16 + 0.36) / 4 = 1.2 / 4 = 0.3
      const data = [
        point(4, true),
        point(4, false),
        point(2, false),
        point(2, true),
      ];
      expect(calculateBrierScore(data)).toBeCloseTo(0.3, 10);
    });

    it('should handle optional fields without affecting the score', () => {
      const withFields = [
        point(3, true, { prReference: '#42', date: '2024-01-01' }),
      ];
      const withoutFields = [point(3, true)];
      expect(calculateBrierScore(withFields)).toBe(calculateBrierScore(withoutFields));
    });
  });

  // -- getCalibrationCurve ----------------------------------------------------

  describe('getCalibrationCurve', () => {
    it('should return an empty array for no data', () => {
      expect(getCalibrationCurve([])).toEqual([]);
    });

    it('should return a single curve point for a single data point', () => {
      const data = [point(3, true)];
      const curve = getCalibrationCurve(data);
      expect(curve).toHaveLength(1);
      expect(curve[0]).toEqual({ confidence: 3, actualAccuracy: 1, count: 1 });
    });

    it('should group by confidence level and compute accuracy', () => {
      const data = [
        point(4, true),
        point(4, true),
        point(4, false),
        point(2, false),
        point(2, true),
      ];
      const curve = getCalibrationCurve(data);

      expect(curve).toHaveLength(2);
      // sorted by confidence
      expect(curve[0]).toEqual({ confidence: 2, actualAccuracy: 0.5, count: 2 });
      expect(curve[1]).toEqual({
        confidence: 4,
        actualAccuracy: 2 / 3,
        count: 3,
      });
    });

    it('should sort results by confidence level ascending', () => {
      const data = [
        point(5, true),
        point(1, false),
        point(3, true),
      ];
      const curve = getCalibrationCurve(data);
      const confidences = curve.map((c) => c.confidence);
      expect(confidences).toEqual([1, 3, 5]);
    });

    it('should handle all-true outcomes at a single level', () => {
      const data = [point(4, true), point(4, true), point(4, true)];
      const curve = getCalibrationCurve(data);
      expect(curve).toHaveLength(1);
      expect(curve[0]!.actualAccuracy).toBe(1);
      expect(curve[0]!.count).toBe(3);
    });

    it('should handle all-false outcomes at a single level', () => {
      const data = [point(3, false), point(3, false)];
      const curve = getCalibrationCurve(data);
      expect(curve).toHaveLength(1);
      expect(curve[0]!.actualAccuracy).toBe(0);
      expect(curve[0]!.count).toBe(2);
    });

    it('should produce all five confidence levels when data spans 1-5', () => {
      const data = [
        point(1, false),
        point(2, false),
        point(3, true),
        point(4, true),
        point(5, true),
      ];
      const curve = getCalibrationCurve(data);
      expect(curve).toHaveLength(5);
      expect(curve.map((c) => c.confidence)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // -- generateInsights -------------------------------------------------------

  describe('generateInsights', () => {
    it('should return a no-data message for an empty array', () => {
      const insights = generateInsights([]);
      expect(insights).toHaveLength(1);
      expect(insights[0]).toContain('No calibration data available');
    });

    it('should warn about limited data when fewer than 5 predictions', () => {
      const data = [point(3, true), point(4, false)];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Limited data'))).toBe(true);
      expect(insights.some((i) => i.includes('2 predictions'))).toBe(true);
    });

    it('should not warn about limited data with 5 or more predictions', () => {
      const data = [
        point(3, true),
        point(4, true),
        point(5, true),
        point(3, true),
        point(4, true),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Limited data'))).toBe(false);
    });

    it('should report excellent calibration for brier score < 0.15', () => {
      // all perfect predictions: confidence 5, outcome true => brier = 0
      const data = Array.from({ length: 10 }, () => point(5, true));
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Excellent calibration'))).toBe(true);
    });

    it('should report good calibration for brier score between 0.15 and 0.25', () => {
      // construct data so brier score is around 0.2
      // forecast=3/5=0.6, outcome=true => err^2=(0.6-1)^2=0.16
      // forecast=3/5=0.6, outcome=false => err^2=(0.6-0)^2=0.36
      // mix to get ~0.2: 7 true + 3 false at confidence 3
      // brier = (7*0.16 + 3*0.36) / 10 = (1.12 + 1.08) / 10 = 0.22
      const data = [
        ...Array.from({ length: 7 }, () => point(3, true)),
        ...Array.from({ length: 3 }, () => point(3, false)),
      ];
      const brier = calculateBrierScore(data);
      expect(brier).toBeGreaterThanOrEqual(0.15);
      expect(brier).toBeLessThan(0.25);
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Good calibration'))).toBe(true);
    });

    it('should report moderate calibration for brier score between 0.25 and 0.35', () => {
      // forecast=3/5=0.6, all false => brier = 0.36 per point
      // mix: 5 true + 5 false at confidence 3
      // brier = (5*0.16 + 5*0.36) / 10 = (0.8 + 1.8) / 10 = 0.26
      const data = [
        ...Array.from({ length: 5 }, () => point(3, true)),
        ...Array.from({ length: 5 }, () => point(3, false)),
      ];
      const brier = calculateBrierScore(data);
      expect(brier).toBeGreaterThanOrEqual(0.25);
      expect(brier).toBeLessThan(0.35);
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Moderate calibration'))).toBe(true);
    });

    it('should report poor calibration for brier score >= 0.35', () => {
      // confidence 5, all false => brier = 1.0
      const data = Array.from({ length: 10 }, () => point(5, false));
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Poor calibration'))).toBe(true);
    });

    it('should detect underconfidence when actual accuracy exceeds expected by >0.2', () => {
      // confidence 1, expected = 0.2, need actual accuracy > 0.4
      // give many successes at confidence 1 => underconfident
      // need at least 3 data points at this level per the count >= 3 check
      const data = [
        point(1, true),
        point(1, true),
        point(1, true),
        point(1, true),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('underconfident') && i.includes('level 1'))).toBe(
        true
      );
    });

    it('should detect overconfidence when actual accuracy is below expected by >0.2', () => {
      // confidence 5, expected = 1.0, need actual accuracy < 0.8
      // mostly failures at confidence 5 => overconfident
      const data = [
        point(5, false),
        point(5, false),
        point(5, false),
        point(5, true),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('overconfident') && i.includes('level 5'))).toBe(
        true
      );
    });

    it('should not flag underconfidence/overconfidence with fewer than 3 data points at a level', () => {
      // only 2 points at confidence 1 with all successes
      const data = [point(1, true), point(1, true)];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('underconfident'))).toBe(false);
      expect(insights.some((i) => i.includes('overconfident'))).toBe(false);
    });

    it('should not flag confidence levels where deviation is <= 0.2', () => {
      // confidence 3, expected = 0.6
      // accuracy = 0.67 (2/3 true), diff = 0.07 <= 0.2 -> no flag
      const data = [point(3, true), point(3, true), point(3, false)];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('underconfident'))).toBe(false);
      expect(insights.some((i) => i.includes('overconfident'))).toBe(false);
    });

    it('should warn about high-confidence predictions with low accuracy', () => {
      // confidence 4 and 5 with mostly failures
      const data = [
        point(4, false),
        point(4, false),
        point(4, false),
        point(5, false),
        point(5, false),
        point(5, true),
        // add some lower confidence to avoid triggering low-confidence message
        point(3, true),
        point(3, true),
        point(3, true),
        point(3, true),
      ];
      // avg high accuracy: confidence>=4 => 4: 0/3=0, 5: 1/3=0.333
      // weighted: (0*3 + 0.333*3) / 6 = 0.1667 < 0.7
      const insights = generateInsights(data);
      expect(
        insights.some((i) => i.includes('requesting pairing') || i.includes('>70% accuracy'))
      ).toBe(true);
    });

    it('should not warn about high-confidence when accuracy is >= 70%', () => {
      // all successes at confidence 4 and 5
      const data = [
        point(4, true),
        point(4, true),
        point(4, true),
        point(5, true),
        point(5, true),
        point(5, true),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('requesting pairing'))).toBe(false);
    });

    it('should warn when >40% of predictions have low confidence', () => {
      // 5 out of 10 predictions at confidence 1-2 => 50% > 40%
      const data = [
        point(1, false),
        point(1, false),
        point(2, false),
        point(2, false),
        point(2, false),
        point(3, true),
        point(4, true),
        point(4, true),
        point(5, true),
        point(5, true),
      ];
      const insights = generateInsights(data);
      expect(
        insights.some((i) => i.includes('low confidence') && i.includes('50%'))
      ).toBe(true);
    });

    it('should not warn about low confidence when <= 40% of predictions are low', () => {
      // 2 out of 10 => 20% <= 40%
      const data = [
        point(1, false),
        point(2, false),
        point(3, true),
        point(3, true),
        point(4, true),
        point(4, true),
        point(4, true),
        point(5, true),
        point(5, true),
        point(5, true),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('low confidence (1-2)'))).toBe(false);
    });

    it('should report strong overall accuracy when > 75%', () => {
      // 8/10 successful
      const data = [
        ...Array.from({ length: 8 }, () => point(4, true)),
        ...Array.from({ length: 2 }, () => point(4, false)),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Strong overall accuracy') && i.includes('80%'))).toBe(
        true
      );
    });

    it('should report low overall accuracy when < 50%', () => {
      // 2/10 successful
      const data = [
        ...Array.from({ length: 2 }, () => point(3, true)),
        ...Array.from({ length: 8 }, () => point(3, false)),
      ];
      const insights = generateInsights(data);
      expect(
        insights.some((i) => i.includes('Low overall accuracy') && i.includes('20%'))
      ).toBe(true);
    });

    it('should not produce accuracy insight when accuracy is between 50% and 75%', () => {
      // 6/10 successful = 60%
      const data = [
        ...Array.from({ length: 6 }, () => point(3, true)),
        ...Array.from({ length: 4 }, () => point(3, false)),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Strong overall accuracy'))).toBe(false);
      expect(insights.some((i) => i.includes('Low overall accuracy'))).toBe(false);
    });

    it('should include the actual percentage in underconfidence/overconfidence messages', () => {
      // underconfidence at level 2: expected 0.4, actual = 1.0 (all true)
      const data = [point(2, true), point(2, true), point(2, true)];
      const insights = generateInsights(data);
      const underconfMsg = insights.find((i) => i.includes('underconfident'));
      expect(underconfMsg).toBeDefined();
      expect(underconfMsg).toContain('100%');
    });
  });

  // -- calculateCalibrationMetrics --------------------------------------------

  describe('calculateCalibrationMetrics', () => {
    it('should return zeroed metrics for empty data', () => {
      const metrics = calculateCalibrationMetrics([]);
      expect(metrics.brierScore).toBe(0);
      expect(metrics.totalPredictions).toBe(0);
      expect(metrics.overallAccuracy).toBe(0);
      expect(metrics.calibrationCurve).toEqual([]);
      expect(metrics.insights).toHaveLength(1);
      expect(metrics.insights[0]).toContain('No calibration data available');
    });

    it('should compute all fields correctly for non-empty data', () => {
      const data = [
        point(5, true),
        point(5, true),
        point(5, false),
        point(3, true),
        point(3, false),
        point(1, false),
      ];
      const metrics = calculateCalibrationMetrics(data);

      expect(metrics.totalPredictions).toBe(6);
      expect(metrics.overallAccuracy).toBeCloseTo(3 / 6, 10);
      expect(metrics.brierScore).toBe(calculateBrierScore(data));
      expect(metrics.calibrationCurve).toEqual(getCalibrationCurve(data));
      expect(metrics.insights.length).toBeGreaterThan(0);
    });

    it('should agree with individual function results', () => {
      const data = [
        point(4, true),
        point(4, true),
        point(2, false),
        point(2, false),
        point(3, true),
      ];
      const metrics = calculateCalibrationMetrics(data);

      expect(metrics.brierScore).toBe(calculateBrierScore(data));
      expect(metrics.calibrationCurve).toEqual(getCalibrationCurve(data));
      expect(metrics.insights).toEqual(generateInsights(data));
      expect(metrics.overallAccuracy).toBeCloseTo(3 / 5, 10);
    });

    it('should set totalPredictions to the length of the data array', () => {
      const data = Array.from({ length: 20 }, (_, i) => point((i % 5) + 1, i % 3 === 0));
      const metrics = calculateCalibrationMetrics(data);
      expect(metrics.totalPredictions).toBe(20);
    });
  });

  // -- formatCalibrationChart -------------------------------------------------

  describe('formatCalibrationChart', () => {
    it('should return a no-data message for an empty curve', () => {
      expect(formatCalibrationChart([])).toBe('No data to display');
    });

    it('should include a title line', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 3, actualAccuracy: 0.6, count: 5 },
      ];
      const chart = formatCalibrationChart(curve);
      expect(chart).toContain('Calibration Chart (Confidence vs Accuracy)');
    });

    it('should include confidence label, actual percentage, and count for each point', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 3, actualAccuracy: 0.6, count: 5 },
      ];
      const chart = formatCalibrationChart(curve);
      expect(chart).toContain('3 |');
      expect(chart).toContain('60%');
      expect(chart).toContain('(n=5)');
    });

    it('should show expected percentage for each confidence level', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 5, actualAccuracy: 0.8, count: 10 },
      ];
      const chart = formatCalibrationChart(curve);
      // expected for confidence 5 = 100%
      expect(chart).toContain('expected: 100%');
    });

    it('should render multiple confidence levels', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 1, actualAccuracy: 0.2, count: 3 },
        { confidence: 3, actualAccuracy: 0.5, count: 4 },
        { confidence: 5, actualAccuracy: 0.9, count: 8 },
      ];
      const chart = formatCalibrationChart(curve);
      expect(chart).toContain('1 |');
      expect(chart).toContain('3 |');
      expect(chart).toContain('5 |');
      expect(chart).toContain('(n=3)');
      expect(chart).toContain('(n=4)');
      expect(chart).toContain('(n=8)');
    });

    it('should handle 0% actual accuracy without errors', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 2, actualAccuracy: 0, count: 4 },
      ];
      const chart = formatCalibrationChart(curve);
      expect(chart).toContain('0%');
      expect(chart).toContain('(n=4)');
    });

    it('should handle 100% actual accuracy', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 4, actualAccuracy: 1, count: 6 },
      ];
      const chart = formatCalibrationChart(curve);
      expect(chart).toContain('100%');
    });

    it('should include bar characters for non-zero accuracy', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 5, actualAccuracy: 0.5, count: 2 },
      ];
      const chart = formatCalibrationChart(curve);
      // actual bar should have some block characters
      expect(chart).toContain('█');
      // expected bar should have some light block characters
      expect(chart).toContain('░');
    });

    it('should not include actual bar characters for 0% accuracy', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 1, actualAccuracy: 0, count: 5 },
      ];
      const chart = formatCalibrationChart(curve);
      const lines = chart.split('\n');
      // find the actual bar line (first line with "1 |")
      const actualLine = lines.find((l) => l.startsWith('1 |'));
      expect(actualLine).toBeDefined();
      // should not contain block characters since accuracy is 0
      expect(actualLine).not.toContain('█');
    });

    it('should produce consistent output for a known curve', () => {
      const curve: CalibrationCurvePoint[] = [
        { confidence: 2, actualAccuracy: 0.5, count: 10 },
      ];
      const chart = formatCalibrationChart(curve);
      const lines = chart.split('\n');

      // title
      expect(lines[0]).toBe('Calibration Chart (Confidence vs Accuracy)');
      // blank line
      expect(lines[1]).toBe('');
      // actual bar line
      expect(lines[2]).toContain('2 |');
      expect(lines[2]).toContain('50%');
      expect(lines[2]).toContain('(n=10)');
      // expected bar line
      expect(lines[3]).toContain('expected: 40%');
    });
  });

  // -- integration / boundary scenarios ---------------------------------------

  describe('integration scenarios', () => {
    it('should handle a large dataset consistently', () => {
      // 100 predictions with varying confidence and outcomes
      const data: CalibrationDataPoint[] = [];
      for (let i = 0; i < 100; i++) {
        const confidence = (i % 5) + 1;
        // outcome correlates loosely with confidence for realism
        const outcome = Math.random() < confidence / 5;
        data.push(point(confidence, outcome));
      }

      const metrics = calculateCalibrationMetrics(data);
      expect(metrics.totalPredictions).toBe(100);
      expect(metrics.brierScore).toBeGreaterThanOrEqual(0);
      expect(metrics.brierScore).toBeLessThanOrEqual(1);
      expect(metrics.overallAccuracy).toBeGreaterThanOrEqual(0);
      expect(metrics.overallAccuracy).toBeLessThanOrEqual(1);
      expect(metrics.calibrationCurve.length).toBeGreaterThan(0);
      expect(metrics.calibrationCurve.length).toBeLessThanOrEqual(5);
      expect(metrics.insights.length).toBeGreaterThan(0);
    });

    it('should handle data where every prediction is successful', () => {
      const data = Array.from({ length: 10 }, (_, i) => point((i % 5) + 1, true));
      const metrics = calculateCalibrationMetrics(data);

      expect(metrics.overallAccuracy).toBe(1);
      expect(metrics.insights.some((i) => i.includes('Strong overall accuracy'))).toBe(true);
    });

    it('should handle data where every prediction fails', () => {
      const data = Array.from({ length: 10 }, (_, i) => point((i % 5) + 1, false));
      const metrics = calculateCalibrationMetrics(data);

      expect(metrics.overallAccuracy).toBe(0);
      expect(metrics.insights.some((i) => i.includes('Low overall accuracy'))).toBe(true);
    });

    it('should handle exactly 4 predictions (limited data threshold)', () => {
      const data = [point(3, true), point(3, true), point(4, false), point(4, true)];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Limited data') && i.includes('4 predictions'))).toBe(
        true
      );
    });

    it('should handle exactly 5 predictions (no limited data warning)', () => {
      const data = [
        point(3, true),
        point(3, true),
        point(4, false),
        point(4, true),
        point(5, true),
      ];
      const insights = generateInsights(data);
      expect(insights.some((i) => i.includes('Limited data'))).toBe(false);
    });

    it('should properly round percentages in insight messages', () => {
      // 1/3 true = 33.33% -> should show 33%
      const data = [point(3, true), point(3, false), point(3, false)];
      // overall accuracy = 33%
      const metrics = calculateCalibrationMetrics(data);
      // look for rounded percentage in low accuracy insight
      const lowMsg = metrics.insights.find((i) => i.includes('Low overall accuracy'));
      expect(lowMsg).toBeDefined();
      expect(lowMsg).toContain('33%');
    });
  });
});
