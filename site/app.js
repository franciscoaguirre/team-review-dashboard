(async function () {
  let data;

  try {
    const resp = await fetch("data.json");
    if (!resp.ok) throw new Error("Failed to load data.json");
    data = resp.json ? await resp.json() : JSON.parse(await resp.text());
  } catch (err) {
    document.getElementById("last-updated").textContent =
      "Could not load data. Run the collect script first.";
    return;
  }

  // --- Header ---
  const generatedAt = new Date(data.generated_at);
  document.getElementById("last-updated").textContent =
    `Last updated: ${relativeTime(generatedAt)} (${generatedAt.toLocaleString()})`;

  // --- Summary cards ---
  const summaryEl = document.getElementById("summary-cards");

  function renderSummary(prs) {
    const stalePrs = prs.filter((pr) => pr.is_stale);
    const cards = [
      { label: "Open PRs", value: prs.length },
      { label: "Stale PRs", value: stalePrs.length, cls: stalePrs.length > 0 ? "stale" : "" },
      { label: "Staleness Threshold", value: `${data.staleness_threshold_hours}h` },
      {
        label: "Avg Turnaround",
        value: data.summary.avg_review_turnaround_hours != null
          ? `${data.summary.avg_review_turnaround_hours}h`
          : "N/A",
      },
    ];
    summaryEl.innerHTML = cards
      .map(
        (c) => `
      <div class="summary-card">
        <div class="label">${c.label}</div>
        <div class="value ${c.cls || ""}">${c.value}</div>
      </div>`
      )
      .join("");
  }

  // --- Filters ---
  const repos = [...new Set(data.open_prs.map((p) => p.repo))];
  const authors = [...new Set(data.open_prs.map((p) => p.author))];
  const filtersEl = document.getElementById("filters");

  const repoSelect = makeSelect("repo-filter", "All repos", repos);
  const authorSelect = makeSelect("author-filter", "All authors", authors);

  const draftLabel = document.createElement("label");
  draftLabel.className = "draft-toggle";
  const draftCheckbox = document.createElement("input");
  draftCheckbox.type = "checkbox";
  draftCheckbox.id = "draft-filter";
  draftLabel.appendChild(draftCheckbox);
  draftLabel.appendChild(document.createTextNode(" Show drafts"));

  filtersEl.appendChild(repoSelect);
  filtersEl.appendChild(authorSelect);
  filtersEl.appendChild(draftLabel);

  repoSelect.addEventListener("change", renderTable);
  authorSelect.addEventListener("change", renderTable);
  draftCheckbox.addEventListener("change", renderTable);

  // --- PR table ---
  function renderTable() {
    const repoVal = repoSelect.value;
    const authorVal = authorSelect.value;
    const showDrafts = draftCheckbox.checked;

    const filtered = data.open_prs.filter((pr) => {
      if (!showDrafts && pr.draft) return false;
      if (repoVal && pr.repo !== repoVal) return false;
      if (authorVal && pr.author !== authorVal) return false;
      return true;
    });

    // Update summary to reflect visible PRs
    const visibleAll = data.open_prs.filter((pr) => !showDrafts ? !pr.draft : true);
    renderSummary(visibleAll);

    const tbody = document.getElementById("pr-tbody");

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No PRs match the current filters</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((pr) => {
        const status = getStatus(pr);
        const labelsHtml = pr.labels
          .map((l) => `<span class="label-tag">${esc(l)}</span>`)
          .join("");

        const sizeClass = pr.size ? `size-${pr.size.toLowerCase()}` : "";
        const sizeHtml = pr.size
          ? `<span class="badge ${sizeClass}">${pr.size}</span>`
          : "";

        const reviewersList = (pr.reviewers || []).map((r) => esc(r));
        const reviewersTooltip = reviewersList.join(", ");
        const reviewersHtml = reviewersList.length <= 2
          ? reviewersList.join(", ")
          : `${reviewersList.slice(0, 2).join(", ")} +${reviewersList.length - 2}`;

        return `<tr>
          <td>
            <a href="${esc(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a>
            ${esc(pr.title)}
            ${labelsHtml ? `<br>${labelsHtml}` : ""}
          </td>
          <td>${esc(pr.author)}</td>
          <td>${esc(pr.repo.split("/")[1])}</td>
          <td>${sizeHtml}</td>
          <td>${formatHours(pr.hours_open)}</td>
          <td class="reviewers-cell" title="${reviewersTooltip}">${reviewersHtml}</td>
          <td>${pr.review_count}</td>
          <td><span class="badge ${status.cls}">${status.text}</span></td>
        </tr>`;
      })
      .join("");
  }

  renderTable();

  // --- Leaderboard chart ---
  const canvas = document.getElementById("leaderboard-chart");
  const ctx = canvas.getContext("2d");
  const lb = data.review_leaderboard;

  const chartHeight = Math.max(200, lb.length * 36);
  canvas.parentElement.style.height = `${chartHeight}px`;

  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const gridColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";
  const textColor = isDark ? "#e0e0e0" : "#1a1a2e";

  new Chart(ctx, {
    type: "bar",
    data: {
      labels: lb.map((l) => l.user),
      datasets: [
        {
          label: "Reviews (30d)",
          data: lb.map((l) => l.reviews_30d),
          backgroundColor: isDark ? "#7aa2f7" : "#4361ee",
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { left: 20 },
      },
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: gridColor },
          ticks: { color: textColor },
        },
        y: {
          grid: { display: false },
          ticks: { color: textColor },
        },
      },
    },
  });

  // --- Helpers ---
  function getStatus(pr) {
    if (pr.draft) return { text: "Draft", cls: "draft" };
    if (pr.is_stale) return { text: "Stale", cls: "stale" };
    if (pr.hours_since_last_review === null && pr.hours_open > 12)
      return { text: "Needs Review", cls: "warning" };
    if (pr.hours_since_last_review !== null && pr.hours_since_last_review > 12)
      return { text: "Needs Review", cls: "warning" };
    return { text: "OK", cls: "ok" };
  }

  function makeSelect(id, placeholder, options) {
    const sel = document.createElement("select");
    sel.id = id;
    sel.innerHTML =
      `<option value="">${placeholder}</option>` +
      options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    return sel;
  }

  function formatHours(h) {
    if (h < 24) return `${h}h`;
    const days = Math.floor(h / 24);
    const rem = h % 24;
    return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
  }

  function relativeTime(date) {
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function esc(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }
})();
