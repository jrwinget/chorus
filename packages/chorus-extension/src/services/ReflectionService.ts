import {
  ReflectionInsight,
  ReflectionAnalytics,
  RetrospectiveEntry,
  DecisionSchemeType,
} from '../types/reflection';
import { LocalDB } from '../storage/LocalDB';

/**
 * service for reflection layer functionality
 * implements pattern detection heuristics and insight generation
 * supports adaptive learning from review outcomes
 */
export class ReflectionService {
  constructor(private readonly db: LocalDB) {}

  /**
   * detects patterns from historical reflection data
   * implements simple heuristics to identify potential issues
   *
   * pattern categories:
   * - scheme mismatch: high-risk prs using weak decision schemes
   * - repeated bias: same bias pattern appearing multiple times
   * - overconfidence: high confidence ratings with poor outcomes
   * - lack of variation: same scheme used too often regardless of context
   *
   * @returns array of insights with evidence
   */
  async detectPatterns(): Promise<ReflectionInsight[]> {
    const insights: ReflectionInsight[] = [];

    // get analytics data
    const analytics = await this.db.getReflectionAnalytics();
    const retrospectives = await this.db.getRetrospectives();

    // pattern 1: lack of variation in decision schemes
    const lackOfVariationInsight = this.detectLackOfVariation(analytics);
    if (lackOfVariationInsight) {
      insights.push(lackOfVariationInsight);
    }

    // pattern 2: repeated bias patterns
    const repeatedBiasInsight = this.detectRepeatedBias(analytics, retrospectives);
    if (repeatedBiasInsight) {
      insights.push(repeatedBiasInsight);
    }

    // pattern 3: scheme-outcome correlation
    const schemeOutcomeInsight = await this.detectSchemeOutcomeCorrelation();
    if (schemeOutcomeInsight) {
      insights.push(schemeOutcomeInsight);
    }

    // pattern 4: overconfidence detection
    const overconfidenceInsight = await this.detectOverconfidence();
    if (overconfidenceInsight) {
      insights.push(overconfidenceInsight);
    }

    return insights;
  }

  /**
   * detects if team is using same scheme too often
   * healthy teams vary their approach based on pr context
   */
  private detectLackOfVariation(analytics: ReflectionAnalytics): ReflectionInsight | null {
    const { scheme_distribution } = analytics;
    const totalSchemes = Object.values(scheme_distribution).reduce((sum, count) => sum + count, 0);

    if (totalSchemes < 5) {
      // not enough data
      return null;
    }

    // check if one scheme dominates (>70%)
    for (const [scheme, count] of Object.entries(scheme_distribution)) {
      const percentage = (count / totalSchemes) * 100;
      if (percentage > 70) {
        return {
          type: 'recommendation',
          title: 'Decision Scheme Variation',
          description: `Your team uses "${scheme}" for ${percentage.toFixed(0)}% of decisions. Consider varying decision rules based on PR context (e.g., use "truth_wins" for technical changes, "consensus" for design decisions).`,
          evidence: [
            `${count} out of ${totalSchemes} decisions used ${scheme}`,
            'recommended: vary schemes based on pr risk and complexity',
          ],
        };
      }
    }

    return null;
  }

  /**
   * detects if same bias pattern appears repeatedly
   * suggests systemic issue that needs addressing
   */
  private detectRepeatedBias(
    analytics: ReflectionAnalytics,
    retrospectives: RetrospectiveEntry[]
  ): ReflectionInsight | null {
    const { bias_frequency } = analytics;
    const totalRetros = retrospectives.length;

    if (totalRetros < 3) {
      // not enough data
      return null;
    }

    // check if any bias appears in >40% of retrospectives
    for (const [bias, count] of Object.entries(bias_frequency)) {
      const percentage = (count / totalRetros) * 100;
      if (percentage > 40 && count >= 3) {
        let suggestion = '';
        switch (bias) {
          case 'groupthink':
            suggestion =
              'Try using blinded reviews more consistently to reduce conformity pressure.';
            break;
          case 'hidden_profile':
            suggestion = 'Encourage reviewers to explicitly share unique information they possess.';
            break;
          case 'status_bias':
            suggestion = 'Emphasize evidence-based feedback over relying on seniority or title.';
            break;
          case 'overconfidence':
            suggestion = 'Use confidence calibration features to improve self-awareness.';
            break;
          default:
            suggestion = 'Consider process changes to address this recurring issue.';
        }

        return {
          type: 'warning',
          title: `Recurring Bias Pattern: ${bias}`,
          description: `"${bias}" has been identified in ${count} out of ${totalRetros} retrospectives (${percentage.toFixed(0)}%). ${suggestion}`,
          evidence: retrospectives
            .filter((r) => {
              try {
                const patterns = JSON.parse(r.bias_patterns);
                return patterns.includes(bias);
              } catch {
                return false;
              }
            })
            .slice(0, 3)
            .map((r) => `PR ${r.pr_id}: ${r.what_went_wrong.substring(0, 100)}...`),
        };
      }
    }

    return null;
  }

  /**
   * correlates decision schemes with outcomes
   * identifies schemes that lead to poor outcomes
   */
  private async detectSchemeOutcomeCorrelation(): Promise<ReflectionInsight | null> {
    // get all decision schemes
    const allRetros = await this.db.getRetrospectives();
    const prIds = [...new Set(allRetros.map((r) => r.pr_id))];

    if (prIds.length < 5) {
      // not enough data
      return null;
    }

    // track scheme usage and bad outcomes
    const schemeOutcomes: Record<string, { total: number; bad: number }> = {};

    for (const prId of prIds) {
      const scheme = await this.db.getDecisionScheme(prId);
      if (!scheme) {
        continue;
      }

      // check if this pr had a retrospective (indicates bad outcome)
      const retros = await this.db.getRetrospectives({ pr_id: prId });
      const hadBadOutcome = retros.length > 0;

      if (!schemeOutcomes[scheme.scheme_type]) {
        schemeOutcomes[scheme.scheme_type] = { total: 0, bad: 0 };
      }

      schemeOutcomes[scheme.scheme_type].total++;
      if (hadBadOutcome) {
        schemeOutcomes[scheme.scheme_type].bad++;
      }
    }

    // find schemes with high failure rate (>50% and at least 3 uses)
    for (const [scheme, stats] of Object.entries(schemeOutcomes)) {
      if (stats.total >= 3) {
        const failureRate = (stats.bad / stats.total) * 100;
        if (failureRate > 50) {
          let recommendation = '';
          if (scheme === 'unanimous') {
            recommendation =
              'unanimous schemes can create pressure to conform. try "consensus" instead to allow for respectful disagreement.';
          } else if (scheme === 'majority') {
            recommendation =
              'majority voting may overlook important dissenting opinions. consider "truth_wins" for technical decisions.';
          } else {
            recommendation = `review when and why "${scheme}" is being used.`;
          }

          return {
            type: 'warning',
            title: `High Failure Rate for ${scheme} Scheme`,
            description: `PRs using "${scheme}" had issues ${failureRate.toFixed(0)}% of the time (${stats.bad} out of ${stats.total} uses). ${recommendation}`,
            evidence: [
              `${stats.bad} retrospectives out of ${stats.total} uses`,
              'consider whether this scheme fits the pr context',
            ],
          };
        }
      }
    }

    return null;
  }

  /**
   * detects overconfidence by comparing ballot confidence with outcomes
   * identifies when reviewers are consistently confident but wrong
   */
  private async detectOverconfidence(): Promise<ReflectionInsight | null> {
    // get all retrospectives
    const allRetros = await this.db.getRetrospectives();

    if (allRetros.length < 3) {
      // not enough data
      return null;
    }

    // check how many retrospectives mention overconfidence bias
    const overconfidentRetros = allRetros.filter((r) => {
      try {
        const patterns = JSON.parse(r.bias_patterns);
        return patterns.includes('overconfidence');
      } catch {
        return false;
      }
    });

    const overconfidenceRate = (overconfidentRetros.length / allRetros.length) * 100;

    if (overconfidenceRate > 30 && overconfidentRetros.length >= 3) {
      return {
        type: 'warning',
        title: 'Overconfidence Pattern Detected',
        description: `${overconfidenceRate.toFixed(0)}% of retrospectives mention overconfidence (${overconfidentRetros.length} out of ${allRetros.length}). Team members may be overstating their certainty in reviews.`,
        evidence: [
          'consider using confidence calibration features',
          'encourage reviewers to acknowledge uncertainty',
          'use "truth_wins" scheme to prioritize evidence over confidence',
        ],
      };
    }

    return null;
  }

  /**
   * checks if a pr outcome should trigger an automatic retrospective
   * monitors for bad outcomes (bugs, reverts) after merge
   *
   * @param prId - pr identifier to check
   * @returns true if retrospective should be triggered
   */
  async shouldTriggerRetrospective(prId: string): Promise<boolean> {
    const outcomes = await this.db.getOutcomesForPR(prId);

    // trigger if any bad outcome detected
    return outcomes.some(
      (outcome) => outcome.outcome_type === 'bug_found' || outcome.outcome_type === 'reverted'
    );
  }

  /**
   * generates recommendation for which decision scheme to use
   * based on pr characteristics and historical patterns
   *
   * @param prId - pr identifier
   * @param riskLevel - risk level from evidence
   * @returns recommended scheme with explanation
   */
  async recommendDecisionScheme(
    _prId: string,
    riskLevel: 'low' | 'medium' | 'high'
  ): Promise<{ scheme: DecisionSchemeType; reason: string }> {
    // get analytics to understand team patterns (future use)
    await this.db.getReflectionAnalytics();

    // high-risk prs should use evidence-based schemes
    if (riskLevel === 'high') {
      return {
        scheme: 'truth_wins',
        reason:
          'high-risk changes benefit from evidence-based decision-making where technical correctness and proof matter most',
      };
    }

    // medium-risk prs benefit from majority agreement
    if (riskLevel === 'medium') {
      return {
        scheme: 'majority',
        reason:
          'medium-risk changes work well with majority voting to balance thoroughness with efficiency',
      };
    }

    // low-risk prs can use consensus
    return {
      scheme: 'consensus',
      reason: 'low-risk changes can use consensus-based decision-making to build team alignment',
    };
  }

  /**
   * exports retrospectives to markdown format
   * supports team retrospective meetings and documentation
   *
   * @param filters - optional filters for which retrospectives to export
   * @returns markdown-formatted report
   */
  async exportRetrospectiveReport(filters?: {
    start_date?: string;
    end_date?: string;
  }): Promise<string> {
    // build filter object with only defined properties
    const filterObj: { start_date?: string; end_date?: string } = {};
    if (filters?.start_date !== undefined) {
      filterObj.start_date = filters.start_date;
    }
    if (filters?.end_date !== undefined) {
      filterObj.end_date = filters.end_date;
    }

    const retrospectives = await this.db.getRetrospectives(
      Object.keys(filterObj).length > 0 ? filterObj : undefined
    );

    if (retrospectives.length === 0) {
      return '# Reflection Report\n\nNo retrospectives found for the specified time period.';
    }

    // get analytics
    const analytics = await this.db.getReflectionAnalytics();
    const insights = await this.detectPatterns();

    // build report
    let report = '# Reflection Report\n\n';

    if (filters?.start_date || filters?.end_date) {
      report += '## Time Period\n\n';
      if (filters.start_date) {
        report += `**From**: ${new Date(filters.start_date).toLocaleDateString()}\n`;
      }
      if (filters.end_date) {
        report += `**To**: ${new Date(filters.end_date).toLocaleDateString()}\n`;
      }
      report += '\n';
    }

    // summary statistics
    report += '## Summary\n\n';
    report += `**Total Retrospectives**: ${retrospectives.length}\n`;
    report += `**Decision Schemes Tracked**: ${Object.keys(analytics.scheme_distribution).length}\n\n`;

    // scheme distribution
    report += '## Decision Scheme Distribution\n\n';
    const totalSchemes = Object.values(analytics.scheme_distribution).reduce(
      (sum, count) => sum + count,
      0
    );
    for (const [scheme, count] of Object.entries(analytics.scheme_distribution)) {
      const percentage = totalSchemes > 0 ? (count / totalSchemes) * 100 : 0;
      report += `- **${scheme}**: ${count} (${percentage.toFixed(1)}%)\n`;
    }
    report += '\n';

    // bias patterns
    if (Object.keys(analytics.bias_frequency).length > 0) {
      report += '## Bias Patterns Identified\n\n';
      for (const [bias, count] of Object.entries(analytics.bias_frequency)) {
        report += `- **${bias}**: ${count} occurrences\n`;
      }
      report += '\n';
    }

    // insights
    if (insights.length > 0) {
      report += '## Pattern Insights\n\n';
      for (const insight of insights) {
        const icon =
          insight.type === 'warning' ? '⚠️' : insight.type === 'recommendation' ? '💡' : '📊';
        report += `### ${icon} ${insight.title}\n\n`;
        report += `${insight.description}\n\n`;
        if (insight.evidence.length > 0) {
          report += '**Evidence**:\n';
          for (const evidence of insight.evidence) {
            report += `- ${evidence}\n`;
          }
          report += '\n';
        }
      }
    }

    // detailed retrospectives
    report += '## Detailed Retrospectives\n\n';
    for (const retro of retrospectives) {
      report += `### PR: ${retro.pr_id}\n\n`;
      report += `**Date**: ${new Date(retro.timestamp).toLocaleDateString()}\n`;
      report += `**Trigger**: ${retro.trigger_type}\n\n`;

      report += '**What Went Wrong**:\n';
      report += `${retro.what_went_wrong}\n\n`;

      report += '**What to Improve**:\n';
      report += `${retro.what_to_improve}\n\n`;

      try {
        const biasPatterns = JSON.parse(retro.bias_patterns);
        if (biasPatterns.length > 0) {
          report += '**Bias Patterns Noted**:\n';
          for (const pattern of biasPatterns) {
            report += `- ${pattern}\n`;
          }
          report += '\n';
        }
      } catch {
        // skip invalid json
      }

      report += '---\n\n';
    }

    report += `*Generated by Chorus on ${new Date().toLocaleDateString()}*\n`;

    return report;
  }
}
