import { LocalDB } from '../storage/LocalDB';
import {
  ThrivingChecklistItemWithTemplate,
  ThrivingAnalytics,
  DimensionAnalytics,
  LabsDimension,
  ThrivingChecklistFilters,
  AutoDetectRule,
} from '../types/thriving';
import { NudgeResponses } from '../types/ballot';

/**
 * Service for Developer Thriving (LABS + TRACE) checklist functionality.
 * Implements auto-detection of checklist items from existing Chorus data,
 * analytics computation, and report generation.
 */
export class ThrivingService {
  constructor(private readonly db: LocalDB) {}

  /**
   * Queries existing Chorus data to auto-detect which checklist items should be checked.
   *
   * Inspects ballots, evidence, retrospectives, decision schemes, and nudge responses
   * for a given PR, then marks matching auto-detectable checklist items.
   *
   * @param prReference - The PR identifier to check
   * @returns Array of item_keys that were detected
   */
  async runAutoDetection(prReference: string): Promise<string[]> {
    // get all templates with auto_detect_rule set (source = 'auto_detected')
    const templates = await this.db.getThrivingTemplates('pr');
    const autoDetectTemplates = templates.filter(
      (t) => t.source === 'auto_detected' && t.auto_detect_rule
    );

    const detectedKeys: string[] = [];

    // pre-fetch data we need for detection
    const ballots = await this.db.getBallotsByPR(prReference);
    const evidence = await this.db.getEvidenceForPR(prReference);
    const retrospectives = await this.db.getRetrospectives({ pr_id: prReference });
    const decisionScheme = await this.db.getDecisionScheme(prReference);

    // check nudge responses from ballots
    let hasNudgeResponse = false;
    for (const ballot of ballots) {
      if (ballot.nudge_responses) {
        try {
          const nudges: NudgeResponses = JSON.parse(ballot.nudge_responses);
          if (
            nudges.consideredAlternatives === true ||
            (nudges.mainRisk !== undefined && nudges.mainRisk !== '') ||
            (nudges.dissentingViews !== undefined && nudges.dissentingViews !== '')
          ) {
            hasNudgeResponse = true;
            break;
          }
        } catch {
          // invalid JSON, skip
        }
      }
    }

    for (const template of autoDetectTemplates) {
      let detected = false;

      try {
        const rule: AutoDetectRule = JSON.parse(template.auto_detect_rule!);

        switch (rule.type) {
          case 'ballot_submitted':
            detected = ballots.length > 0;
            break;
          case 'evidence_added':
            detected = evidence.length > 0;
            break;
          case 'retrospective_recorded':
            detected = retrospectives.length > 0;
            break;
          case 'scheme_recorded':
            detected = decisionScheme !== null;
            break;
          case 'nudge_responded':
            detected = hasNudgeResponse;
            break;
        }
      } catch {
        // invalid auto_detect_rule JSON, skip
        continue;
      }

      if (detected) {
        await this.db.markAutoDetected(prReference, template.item_key, true);
        detectedKeys.push(template.item_key);
      }
    }

    return detectedKeys;
  }

  /**
   * Returns the full checklist for a PR, including both LABS (per-PR) and TRACE (team) items.
   *
   * 1. Initializes checklist rows for the PR (idempotent)
   * 2. Runs auto-detection to check items from existing Chorus data
   * 3. Returns combined LABS + TRACE items
   *
   * @param prReference - The PR identifier
   * @returns Object with labsItems, traceItems, and autoDetectedKeys
   */
  async getChecklistForPR(prReference: string): Promise<{
    labsItems: ThrivingChecklistItemWithTemplate[];
    traceItems: ThrivingChecklistItemWithTemplate[];
    autoDetectedKeys: string[];
  }> {
    // initialize checklist for this PR (idempotent)
    await this.db.initializeChecklistForPR(prReference);

    // run auto-detection
    const autoDetectedKeys = await this.runAutoDetection(prReference);

    // fetch the updated LABS items
    const labsItems = await this.db.getThrivingChecklist(prReference);

    // fetch TRACE (team-wide) items
    const traceItems = await this.db.getTraceChecklist();

    return { labsItems, traceItems, autoDetectedKeys };
  }

  /**
   * Computes thriving analytics across all dimensions.
   *
   * Aggregates completion rates per LABS dimension, determines trends,
   * identifies neglected and strong dimensions, and computes TRACE completion.
   *
   * @param filters - Optional filters for pr_reference, date range
   * @returns Full ThrivingAnalytics object
   */
  async computeAnalytics(filters?: ThrivingChecklistFilters): Promise<ThrivingAnalytics> {
    // get per-dimension aggregates from DB
    const rawAnalytics = await this.db.getThrivingAnalytics(filters);

    // determine pr_count: count distinct PRs in the checklist data
    // we approximate by looking at the item_count / items-per-pr ratio
    // or we just use item_count as a proxy for data sufficiency
    const allDimensions: LabsDimension[] = [
      'learning_culture',
      'agency',
      'belonging',
      'self_efficacy',
    ];

    const dimensionMap = new Map(rawAnalytics.map((r) => [r.dimension, r]));

    const dimensions: DimensionAnalytics[] = allDimensions.map((dim) => {
      const raw = dimensionMap.get(dim);
      if (!raw) {
        return {
          dimension: dim,
          completion_rate: 0,
          trend: 'insufficient_data' as const,
          pr_count: 0,
        };
      }

      // use item_count as a proxy for pr_count
      // each PR contributes N items per dimension, so pr_count ~ item_count / items-per-dimension
      // For simplicity: if total items < 5, insufficient data
      const prCount = raw.item_count;
      const trend: DimensionAnalytics['trend'] = prCount < 5 ? 'insufficient_data' : 'stable';

      return {
        dimension: dim,
        completion_rate: raw.completion_rate,
        trend,
        pr_count: prCount,
      };
    });

    // identify neglected dimensions (completion_rate < 0.25)
    const neglectedDimensions: LabsDimension[] = dimensions
      .filter((d) => d.completion_rate < 0.25)
      .map((d) => d.dimension);

    // identify strong dimensions (completion_rate > 0.75)
    const strongDimensions: LabsDimension[] = dimensions
      .filter((d) => d.completion_rate > 0.75)
      .map((d) => d.dimension);

    // compute overall thriving score as average of all dimension completion rates
    const overallThrivingScore =
      dimensions.length > 0
        ? dimensions.reduce((sum, d) => sum + d.completion_rate, 0) / dimensions.length
        : 0;

    // get TRACE completion
    const traceItems = await this.db.getTraceChecklist();
    const traceChecked = traceItems.filter((item) => item.checked).length;
    const traceCompletion = traceItems.length > 0 ? traceChecked / traceItems.length : 0;

    return {
      dimensions,
      trace_completion: traceCompletion,
      overall_thriving_score: overallThrivingScore,
      neglected_dimensions: neglectedDimensions,
      strong_dimensions: strongDimensions,
    };
  }

  /**
   * Generates a markdown summary of thriving analytics for export.
   *
   * @returns Markdown-formatted report string
   */
  async generateReportSection(): Promise<string> {
    const analytics = await this.computeAnalytics();

    const dimensionLabels: Record<LabsDimension, string> = {
      learning_culture: 'Learning Culture',
      agency: 'Agency',
      belonging: 'Belonging',
      self_efficacy: 'Self-Efficacy',
    };

    let report = '## Developer Thriving Checklist\n\n';

    report += '### LABS Dimensions\n';
    for (const dim of analytics.dimensions) {
      const label = dimensionLabels[dim.dimension];
      const pct = Math.round(dim.completion_rate * 100);
      report += `- ${label}: ${pct}% completion\n`;
    }

    report += '\n### TRACE Principles\n';
    const traceItems = await this.db.getTraceChecklist();
    const traceChecked = traceItems.filter((item) => item.checked).length;
    report += `${traceChecked} of ${traceItems.length} principles checked\n`;

    report += `\n### Overall Thriving Score: ${Math.round(analytics.overall_thriving_score * 100)}%\n`;

    return report;
  }
}
