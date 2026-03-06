const { Octokit } = require("@octokit/rest");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.yml");
const OUTPUT_PATH = path.join(__dirname, "..", "site", "data.json");

const SEARCH_PRS_QUERY = `
query($searchQuery: String!, $cursor: String) {
  rateLimit { remaining resetAt }
  search(query: $searchQuery, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        createdAt
        isDraft
        additions
        deletions
        author { login }
        repository { nameWithOwner }
        labels(first: 10) { nodes { name } }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } } } }
        reviews(first: 50) {
          nodes {
            state
            submittedAt
            author { login }
          }
        }
      }
    }
  }
}`;

async function graphqlWithRetry(octokit, query, vars) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await octokit.graphql(query, vars);
      const rl = result.rateLimit;
      if (rl) {
        console.log(`  Rate limit remaining: ${rl.remaining} (resets ${rl.resetAt})`);
        if (rl.remaining < 50) {
          const waitMs = Math.max(0, new Date(rl.resetAt) - Date.now()) + 1000;
          console.log(`  Rate limit low, waiting ${Math.round(waitMs / 1000)}s...`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      return result;
    } catch (err) {
      if (attempt < 2 && (err.status === 403 || err.message.includes("rate limit"))) {
        const waitSec = 60 * (attempt + 1);
        console.warn(`  Rate limited, retrying in ${waitSec}s...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
  const repos = config.repos;
  const stalenessHours = config.staleness_threshold_hours || 24;
  const now = new Date();

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
  });

  const openPRs = [];
  const repoFilter = repos.map((r) => `repo:${r}`).join(" ");

  // One search query per team member — fetches only their PRs across all repos
  for (const user of config.team) {
    const searchQuery = `is:pr is:open author:${user} ${repoFilter}`;
    console.log(`Fetching open PRs for ${user}...`);

    try {
      let cursor = null;
      let hasMore = true;

      while (hasMore) {
        const result = await graphqlWithRetry(octokit, SEARCH_PRS_QUERY, { searchQuery, cursor });
        const { nodes, pageInfo } = result.search;

        for (const pr of nodes) {
          if (!pr.author) continue;

          const openedAt = new Date(pr.createdAt);
          const hoursOpen = Math.round((now - openedAt) / (1000 * 60 * 60));

          const reviews = pr.reviews.nodes.filter(
            (r) => r.state !== "PENDING"
          );
          const reviewDates = reviews.map((r) => new Date(r.submittedAt));

          const lastReviewAt =
            reviewDates.length > 0
              ? new Date(Math.max(...reviewDates))
              : null;

          const hoursSinceLastReview = lastReviewAt
            ? Math.round((now - lastReviewAt) / (1000 * 60 * 60))
            : null;

          const isStale = lastReviewAt
            ? hoursSinceLastReview >= stalenessHours
            : false;

          const requestedReviewers = pr.reviewRequests.nodes
            .map((r) => r.requestedReviewer?.login)
            .filter(Boolean);
          const reviewedBy = [
            ...new Set(reviews.map((r) => r.author?.login).filter(Boolean)),
          ];
          const reviewers = [...new Set([...requestedReviewers, ...reviewedBy])];

          const totalLines = pr.additions + pr.deletions;
          const size =
            totalLines <= 200
              ? "S"
              : totalLines <= 500
              ? "M"
              : totalLines <= 1000
              ? "L"
              : "XL";

          openPRs.push({
            repo: pr.repository.nameWithOwner,
            number: pr.number,
            title: pr.title,
            author: pr.author.login,
            url: pr.url,
            opened_at: pr.createdAt,
            hours_open: hoursOpen,
            review_count: reviewDates.length,
            last_review_at: lastReviewAt ? lastReviewAt.toISOString() : null,
            hours_since_last_review: hoursSinceLastReview,
            is_stale: isStale,
            labels: pr.labels.nodes.map((l) => l.name),
            draft: pr.isDraft,
            reviewers,
            additions: pr.additions,
            deletions: pr.deletions,
            size,
          });
        }

        hasMore = pageInfo.hasNextPage;
        cursor = pageInfo.endCursor;
      }
    } catch (err) {
      console.warn(`Warning: Could not fetch PRs for ${user}: ${err.message}`);
    }
  }

  // Review leaderboard via Search API
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const since = thirtyDaysAgo.toISOString().split("T")[0];

  const leaderboard = [];

  for (const user of config.team) {
    console.log(`Fetching review activity for ${user}...`);

    const query = `is:pr reviewed-by:${user} created:>=${since} ${repoFilter}`;

    try {
      const { data } = await octokit.rest.search.issuesAndPullRequests({
        q: query,
        per_page: 1,
      });

      leaderboard.push({
        user,
        reviews_30d: data.total_count,
        avg_turnaround_hours: null,
      });
    } catch (err) {
      console.warn(`Warning: Could not fetch review data for ${user}: ${err.message}`);
      leaderboard.push({
        user,
        reviews_30d: 0,
        avg_turnaround_hours: null,
      });
    }
  }

  leaderboard.sort((a, b) => b.reviews_30d - a.reviews_30d);

  // Sort PRs: stale first, then newest first
  openPRs.sort((a, b) => {
    if (a.is_stale !== b.is_stale) return a.is_stale ? -1 : 1;
    return a.hours_open - b.hours_open;
  });

  const stalePRs = openPRs.filter((pr) => pr.is_stale);
  const avgTurnaround = leaderboard.filter((l) => l.avg_turnaround_hours !== null);

  const output = {
    generated_at: now.toISOString(),
    staleness_threshold_hours: stalenessHours,
    open_prs: openPRs,
    review_leaderboard: leaderboard,
    summary: {
      total_open_prs: openPRs.length,
      stale_prs: stalePRs.length,
      avg_review_turnaround_hours:
        avgTurnaround.length > 0
          ? Math.round(
              (avgTurnaround.reduce((s, l) => s + l.avg_turnaround_hours, 0) /
                avgTurnaround.length) *
                10
            ) / 10
          : null,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  Open PRs: ${output.summary.total_open_prs}`);
  console.log(`  Stale PRs: ${output.summary.stale_prs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
