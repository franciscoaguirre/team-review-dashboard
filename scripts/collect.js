const { Octokit } = require("@octokit/rest");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.yml");
const OUTPUT_PATH = path.join(__dirname, "..", "site", "data.json");

const PR_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        createdAt
        isDraft
        additions
        deletions
        author { login }
        labels(first: 20) { nodes { name } }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
        reviews(first: 100) {
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

async function main() {
  const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));
  const team = new Set(config.team);
  const repos = config.repos;
  const stalenessHours = config.staleness_threshold_hours || 24;
  const now = new Date();

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
  });

  const openPRs = [];

  for (const repoFullName of repos) {
    const [owner, repo] = repoFullName.split("/");
    console.log(`Fetching PRs for ${repoFullName}...`);

    try {
      let cursor = null;
      let hasMore = true;

      while (hasMore) {
        const result = await octokit.graphql(PR_QUERY, { owner, repo, cursor });
        const { nodes: pulls, pageInfo } = result.repository.pullRequests;

        for (const pr of pulls) {
          if (!pr.author || !team.has(pr.author.login)) continue;

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
            : hoursOpen >= stalenessHours;

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
            repo: repoFullName,
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
      console.warn(`Warning: Could not fetch PRs for ${repoFullName}: ${err.message}`);
    }
  }

  // Review leaderboard via Search API
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const since = thirtyDaysAgo.toISOString().split("T")[0];

  const leaderboard = [];

  for (const user of config.team) {
    console.log(`Fetching review activity for ${user}...`);

    const repoFilter = repos.map((r) => `repo:${r}`).join("+");
    const query = `is:pr+reviewed-by:${user}+created:>=${since}+${repoFilter}`;

    try {
      const { data } = await octokit.rest.search.issuesAndPullRequests({
        q: query,
        per_page: 1,
      });

      leaderboard.push({
        user,
        reviews_30d: data.total_count,
        avg_turnaround_hours: null, // Would require deeper analysis per-review
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
  const totalReviews = leaderboard.reduce((s, l) => s + l.reviews_30d, 0);
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
