/**
 * Calibration utility functions for confidence vs accuracy analysis.
 *
 * Implements Brier score calculation and calibration curve generation
 * to help users understand their prediction accuracy and identify
 * overconfidence or underconfidence patterns.
 *
 * Based on calibration theory from decision science and forecasting research.
 */

/**
 * Single data point for calibration analysis
 */
export interface CalibrationDataPoint {
  confidence: number; // 1-5 scale
  outcome: boolean; // true = success, false = failure
  prReference?: string; // optional PR identifier for tracking
  date?: string; // optional timestamp
}

/**
 * Calibration curve point showing confidence level vs actual accuracy
 */
export interface CalibrationCurvePoint {
  confidence: number; // 1-5
  actualAccuracy: number; // 0-1 (percentage as decimal)
  count: number; // number of predictions at this confidence level
}

/**
 * Calibration metrics and insights
 */
export interface CalibrationMetrics {
  brierScore: number; // 0-1, lower is better
  totalPredictions: number;
  overallAccuracy: number; // 0-1
  calibrationCurve: CalibrationCurvePoint[];
  insights: string[];
}

/**
 * Calculates the Brier score for a set of predictions.
 *
 * Brier score measures the accuracy of probabilistic predictions:
 * - Score of 0 = perfect calibration
 * - Score of 1 = worst possible calibration
 * - Lower scores indicate better calibration
 *
 * Formula: (1/N) * Σ(forecast - outcome)²
 * where forecast is confidence/5 (normalized to 0-1)
 * and outcome is 1 for success, 0 for failure
 *
 * @param data - Array of calibration data points
 * @returns Brier score (0-1)
 */
export function calculateBrierScore(data: CalibrationDataPoint[]): number {
  if (data.length === 0) {
    return 0;
  }

  let sum = 0;
  for (const point of data) {
    // normalize confidence from 1-5 scale to 0-1 probability
    const forecast = point.confidence / 5;
    const outcome = point.outcome ? 1 : 0;
    const error = forecast - outcome;
    sum += error * error;
  }

  return sum / data.length;
}

/**
 * Generates a calibration curve showing confidence vs actual accuracy.
 *
 * Groups predictions by confidence level and calculates the actual
 * success rate for each level. A well-calibrated reviewer's curve
 * should be close to the identity line (confidence = accuracy).
 *
 * @param data - Array of calibration data points
 * @returns Array of calibration curve points
 */
export function getCalibrationCurve(data: CalibrationDataPoint[]): CalibrationCurvePoint[] {
  if (data.length === 0) {
    return [];
  }

  // group by confidence level
  const grouped = new Map<number, boolean[]>();

  for (const point of data) {
    if (!grouped.has(point.confidence)) {
      grouped.set(point.confidence, []);
    }
    grouped.get(point.confidence)!.push(point.outcome);
  }

  // calculate accuracy for each confidence level
  const curve: CalibrationCurvePoint[] = [];

  for (const [confidence, outcomes] of grouped.entries()) {
    const successCount = outcomes.filter((o) => o).length;
    const actualAccuracy = successCount / outcomes.length;

    curve.push({
      confidence,
      actualAccuracy,
      count: outcomes.length,
    });
  }

  // sort by confidence level
  return curve.sort((a, b) => a.confidence - b.confidence);
}

/**
 * Generates calibration insights based on the data.
 *
 * Analyzes calibration patterns to provide actionable feedback:
 * - Overconfidence: high confidence but low accuracy
 * - Underconfidence: low confidence but high accuracy
 * - Well-calibrated: confidence matches accuracy
 * - Insufficient data warnings
 *
 * @param data - Array of calibration data points
 * @returns Array of insight strings
 */
export function generateInsights(data: CalibrationDataPoint[]): string[] {
  const insights: string[] = [];

  if (data.length === 0) {
    insights.push(
      'No calibration data available. Submit ballots and tag outcomes to build your profile.'
    );
    return insights;
  }

  if (data.length < 5) {
    insights.push(
      `Limited data (${data.length} predictions). Insights become more reliable after 10+ predictions.`
    );
  }

  const curve = getCalibrationCurve(data);
  const brierScore = calculateBrierScore(data);
  const overallAccuracy = data.filter((d) => d.outcome).length / data.length;

  // interpret brier score
  if (brierScore < 0.15) {
    insights.push('Excellent calibration! Your confidence levels align well with actual outcomes.');
  } else if (brierScore < 0.25) {
    insights.push('Good calibration. Minor adjustments could improve accuracy.');
  } else if (brierScore < 0.35) {
    insights.push('Moderate calibration. Consider reviewing your confidence assessments.');
  } else {
    insights.push('Poor calibration. Significant gap between confidence and accuracy.');
  }

  // analyze confidence-specific patterns
  for (const point of curve) {
    const expectedAccuracy = point.confidence / 5; // normalized
    const diff = point.actualAccuracy - expectedAccuracy;

    if (Math.abs(diff) > 0.2 && point.count >= 3) {
      // significant deviation with enough data
      if (diff > 0.2) {
        insights.push(
          `You tend to be underconfident at confidence level ${point.confidence}. Your actual accuracy (${Math.round(point.actualAccuracy * 100)}%) exceeds expectations.`
        );
      } else if (diff < -0.2) {
        insights.push(
          `You tend to be overconfident at confidence level ${point.confidence}. Your actual accuracy (${Math.round(point.actualAccuracy * 100)}%) is below expectations.`
        );
      }
    }
  }

  // high confidence analysis
  const highConfidence = curve.filter((p) => p.confidence >= 4);
  if (highConfidence.length > 0) {
    const totalHighCount = highConfidence.reduce((sum, p) => sum + p.count, 0);
    if (totalHighCount > 0) {
      const avgHighAccuracy =
        highConfidence.reduce((sum, p) => sum + p.actualAccuracy * p.count, 0) / totalHighCount;

      if (avgHighAccuracy < 0.7) {
        insights.push(
          'Consider requesting pairing or additional review when confidence is below 4. High-confidence predictions should have >70% accuracy.'
        );
      }
    }
  }

  // low confidence analysis
  const lowConfidence = curve.filter((p) => p.confidence <= 2);
  if (lowConfidence.length > 0) {
    const totalLowConf = lowConfidence.reduce((sum, p) => sum + p.count, 0);
    if (totalLowConf > data.length * 0.4) {
      insights.push(
        `${Math.round((totalLowConf / data.length) * 100)}% of your predictions have low confidence (1-2). Consider building more context or deferring review.`
      );
    }
  }

  // overall accuracy insight
  if (overallAccuracy > 0.75) {
    insights.push(
      `Strong overall accuracy (${Math.round(overallAccuracy * 100)}%). Your reviews generally align with outcomes.`
    );
  } else if (overallAccuracy < 0.5) {
    insights.push(
      `Low overall accuracy (${Math.round(overallAccuracy * 100)}%). Review your decision criteria and seek feedback from teammates.`
    );
  }

  return insights;
}

/**
 * Calculates comprehensive calibration metrics.
 *
 * Convenience function that computes Brier score, calibration curve,
 * and generates insights in a single call.
 *
 * @param data - Array of calibration data points
 * @returns Complete calibration metrics object
 */
export function calculateCalibrationMetrics(data: CalibrationDataPoint[]): CalibrationMetrics {
  const brierScore = calculateBrierScore(data);
  const calibrationCurve = getCalibrationCurve(data);
  const insights = generateInsights(data);
  const overallAccuracy = data.length > 0 ? data.filter((d) => d.outcome).length / data.length : 0;

  return {
    brierScore,
    totalPredictions: data.length,
    overallAccuracy,
    calibrationCurve,
    insights,
  };
}

/**
 * Formats calibration curve data for ASCII chart visualization.
 *
 * Creates a simple text-based visualization suitable for terminal display.
 * Shows confidence levels (1-5) vs actual accuracy.
 *
 * @param curve - Calibration curve data
 * @returns Multi-line ASCII chart string
 */
export function formatCalibrationChart(curve: CalibrationCurvePoint[]): string {
  if (curve.length === 0) {
    return 'No data to display';
  }

  const lines: string[] = [];
  lines.push('Calibration Chart (Confidence vs Accuracy)');
  lines.push('');

  // create scale
  const scale = 40; // characters wide

  for (const point of curve) {
    const expectedAccuracy = point.confidence / 5;
    const expectedBar = Math.round(expectedAccuracy * scale);
    const actualBar = Math.round(point.actualAccuracy * scale);

    const confLabel = `${point.confidence}`;
    const actualPct = Math.round(point.actualAccuracy * 100);
    const countLabel = `(n=${point.count})`;

    // create bars
    const actualBarStr = '█'.repeat(actualBar);
    const expectedBarStr = '░'.repeat(expectedBar);

    lines.push(`${confLabel} | ${actualBarStr} ${actualPct}% ${countLabel}`);
    lines.push(`  | ${expectedBarStr} expected: ${Math.round(expectedAccuracy * 100)}%`);
    lines.push('');
  }

  return lines.join('\n');
}
