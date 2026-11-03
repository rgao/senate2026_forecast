/**
 * docs/js/app.js
 * 2026 U.S. Senate Forecasting Engine — Interactive Front-End Logic
 *
 * Features:
 * - Fetches ./data/sim_results.json and ../data/state_voter_index.csv (with fallback to ./data/state_voter_index.csv)
 * - Classifies all 35 contested races strictly by Expected Median Margin (mu_s):
 *     * Tilt:   |Margin| < 1.0%
 *     * Lean:   1.0% <= |Margin| < 5.0%
 *     * Likely: 5.0% <= |Margin| < 12.0%
 *     * Solid:  |Margin| >= 12.0%
 * - Supports 4-shade palettes for Democrats (Blue), Republicans (Red), and Independent frontrunners (Purple)
 * - Renders diagonal SVG hatch overlay (<pattern id="flip-hatch">) on seats projected to flip parties
 * - Compact high-density hover tooltip displaying Candidate shares, Win Prob, Cook PVI (0.65/0.35),
 *   2024 Presidential baseline margin, Campaign Spend, GA Runoff probability, and AK/ME RCV round-by-round breakdown
 * - Interactive 100-seat chamber balance bar, 40,000-trial seat distribution histogram, and sortable table
 */

// ---------------------------------------------------------
// 1. Color Palettes & FIPS Mapping
// ---------------------------------------------------------
const COLORS = {
  DEM: {
    Solid: "#1a3a8a",
    Likely: "#2b6cb0",
    Lean: "#4299e1",
    Tilt: "#90cdf4"
  },
  GOP: {
    Solid: "#991b1b",
    Likely: "#c53030",
    Lean: "#e53e3e",
    Tilt: "#feb2b2"
  },
  IND: {
    Solid: "#4c2882",
    Likely: "#6e4c9e",
    Lean: "#987bb8",
    Tilt: "#bfa8d4"
  },
  UNCONTESTED: "#e2e8f0"
};

const FIPS_TO_STATE = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA",
  "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN",
  "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
  "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS",
  "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
  "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
  "56": "WY"
};

const STATE_NAMES_FULL = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
};

// Statutory RCV parameters for Round 1 vs Final Round display
const RCV_STATUTORY_META = {
  AK: {
    system: "Top-4 Ranked-Choice Voting",
    first_choice_share_major: 0.94,
    minor_exhaust_rate: 0.15,
    gop_second_choice_flow: 0.75,
    note: "6.0% Round 1 minor conservative/other pool; 75% of active transfers flow to Sullivan (R)."
  },
  ME: {
    system: "Ranked-Choice Voting (RCV)",
    first_choice_share_major: 0.98,
    minor_exhaust_rate: 0.10,
    dem_second_choice_flow: 0.55,
    note: "2.0% Round 1 minor/write-in pool; 55% of active transfers flow to Jackson (D)."
  }
};

// Global state store
let simData = null;
let voterIndexMap = {};
let enrichedRaces = [];
let currentSort = { key: "tipping_point_prob", asc: false };

// ---------------------------------------------------------
// 2. Helper & Classification Functions
// ---------------------------------------------------------
function isIndependentCandidate(candName) {
  return candName && candName.includes("(Ind)");
}

function cleanCandidateName(candName) {
  if (!candName) return "";
  return candName.replace(/\s*\(Ind\)/i, "").trim();
}

/**
 * Classifies a race strictly by Expected Median Margin (mu_s), NOT win probability.
 * Margin > 0 => Dem or Independent Challenger leads
 * Margin < 0 => GOP leads
 */
function classifyByMargin(medianMargin, demCandName) {
  const absM = Math.abs(medianMargin);
  const isIndChallenger = isIndependentCandidate(demCandName);
  const leadingParty = medianMargin >= 0 ? (isIndChallenger ? "IND" : "DEM") : "GOP";
  const partyLabel = leadingParty === "IND" ? "Ind" : (leadingParty === "DEM" ? "D" : "R");

  let tier = "Tilt";
  if (absM >= 12.0) {
    tier = "Solid";
  } else if (absM >= 5.0) {
    tier = "Likely";
  } else if (absM >= 1.0) {
    tier = "Lean";
  } else {
    tier = "Tilt";
  }

  return {
    tier,
    leadingParty,
    partyLabel,
    label: `${tier} ${partyLabel}`,
    color: COLORS[leadingParty][tier],
    sortRank: medianMargin // signed for sorting D -> R
  };
}

/**
 * Determines if the projected winner represents a party flip from the current incumbent.
 */
function isProjectedFlip(race) {
  const winnerParty = race.median_margin >= 0
    ? (isIndependentCandidate(race.dem_candidate) ? "IND" : "DEM")
    : "GOP";
  // Note: If an Independent unseats a GOP incumbent, or DEM unseats GOP, or GOP unseats DEM
  return winnerParty !== race.incumbent_party;
}

function formatSignedMargin(margin, demCandName) {
  const absVal = Math.abs(margin).toFixed(1);
  if (Math.abs(margin) < 0.05) return "EVEN";
  if (margin > 0) {
    const prefix = isIndependentCandidate(demCandName) ? "I" : "D";
    return `${prefix}+${absVal}`;
  }
  return `R+${absVal}`;
}

function formatPVI(pvi) {
  if (pvi === undefined || pvi === null || isNaN(pvi)) return "EVEN";
  const absVal = Math.abs(pvi).toFixed(1);
  if (Math.abs(pvi) < 0.05) return "EVEN";
  return pvi > 0 ? `D+${absVal}` : `R+${absVal}`;
}

function formatPres2024(margin2024) {
  if (margin2024 === undefined || margin2024 === null || isNaN(margin2024)) return "N/A";
  const absVal = Math.abs(margin2024).toFixed(1);
  return margin2024 >= 0 ? `Harris +${absVal}%` : `Trump +${absVal}%`;
}

/**
 * Computes estimated candidate vote shares & RCV round-by-round breakdown if applicable.
 */
function computeVoteShares(st, race) {
  const m = race.median_margin;
  if (st === "AK" || st === "ME") {
    const meta = RCV_STATUTORY_META[st];
    const firstMajor = meta.first_choice_share_major;
    const demR1 = ((0.50 + m / 200.0) * firstMajor) * 100;
    const gopR1 = ((0.50 - m / 200.0) * firstMajor) * 100;
    const minorR1 = (1.0 - firstMajor) * 100;

    // Simulated final round after non-exhausted transfers
    const activeMinor = minorR1 * (1.0 - meta.minor_exhaust_rate);
    let demFinalRaw, gopFinalRaw;
    if (st === "AK") {
      demFinalRaw = demR1 + activeMinor * (1.0 - meta.gop_second_choice_flow);
      gopFinalRaw = gopR1 + activeMinor * meta.gop_second_choice_flow;
    } else {
      demFinalRaw = demR1 + activeMinor * meta.dem_second_choice_flow;
      gopFinalRaw = gopR1 + activeMinor * (1.0 - meta.dem_second_choice_flow);
    }
    const twoPartySum = demFinalRaw + gopFinalRaw;
    const demFinalTwoParty = (demFinalRaw / twoPartySum) * 100;
    const gopFinalTwoParty = (gopFinalRaw / twoPartySum) * 100;
    const finalMargin = demFinalRaw - gopFinalRaw;

    return {
      isRCV: true,
      demShare: demR1.toFixed(1),
      gopShare: gopR1.toFixed(1),
      minorShare: minorR1.toFixed(1),
      demFinal: demFinalTwoParty.toFixed(1),
      gopFinal: gopFinalTwoParty.toFixed(1),
      finalMargin: finalMargin,
      rcvNote: meta.note
    };
  }

  // Standard or Georgia race (assume ~1.6% minor/write-in share in GA, ~1.2% elsewhere)
  const majorPool = st === "GA" ? 98.0 : 98.8;
  const demShare = (0.50 + m / 200.0) * majorPool;
  const gopShare = (0.50 - m / 200.0) * majorPool;

  return {
    isRCV: false,
    demShare: demShare.toFixed(1),
    gopShare: gopShare.toFixed(1),
    minorShare: (100 - majorPool).toFixed(1)
  };
}

// ---------------------------------------------------------
// 3. Data Loading & Initialization
// ---------------------------------------------------------
async function initDashboard() {
  try {
    // Determine resilient base path for GitHub Pages subfolder repositories
    const baseHref = window.location.pathname.endsWith('/') 
      ? window.location.pathname 
      : window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);

    const candidateJsonUrls = [
      `${baseHref}data/sim_results.json`,
      "./data/sim_results.json",
      "data/sim_results.json"
    ];

    let simRes = null;
    for (const url of candidateJsonUrls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("json") || contentType.includes("octet-stream") || contentType.includes("text/plain")) {
            simRes = res;
            break;
          }
        }
      } catch (e) {
        // try next
      }
    }

    if (!simRes) {
      throw new Error("Could not load sim_results.json from /data/. Make sure docs/data/sim_results.json is committed to Git and not ignored by .gitignore!");
    }

    simData = await simRes.json();

    // Load state voter index CSV
    const candidateCsvUrls = [
      `${baseHref}data/state_voter_index.csv`,
      "./data/state_voter_index.csv",
      "data/state_voter_index.csv",
      "../data/state_voter_index.csv"
    ];

    let csvText = "";
    for (const url of candidateCsvUrls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          csvText = await res.text();
          if (csvText && !csvText.startsWith("<!DOCTYPE")) {
            break;
          }
        }
      } catch (e) {
        // try next
      }
    }

    if (csvText && !csvText.startsWith("<!DOCTYPE")) {
      const parsedCsv = d3.csvParse(csvText);
      parsedCsv.forEach(row => {
        const stCode = (row.state || row[""] || "").trim();
        if (stCode) {
          voterIndexMap[stCode] = {
            margin_2020: parseFloat(row.margin_2020),
            margin_2024: parseFloat(row.margin_2024),
            pvi: parseFloat(row.pvi),
            elasticity: parseFloat(row.elasticity)
          };
        }
      });
    }

    // 3. Enrich races array
    const projections = simData.state_projections || {};
    enrichedRaces = Object.keys(projections).map(st => {
      const r = projections[st];
      const vi = voterIndexMap[st] || {};
      const classification = classifyByMargin(r.median_margin, r.dem_candidate);
      const flip = isProjectedFlip(r);
      const leaderWinProb = r.median_margin >= 0 ? r.dem_win_prob : r.gop_win_prob;
      const pres2024 = !isNaN(vi.margin_2024) ? vi.margin_2024 : null;

      return {
        state: st,
        ...r,
        pres_2024: pres2024,
        elasticity: vi.elasticity || 1.0,
        classification,
        isFlip: flip,
        leaderWinProb
      };
    });

    // 4. Render UI Components
    renderTopBanner();
    renderStatutoryWatchSidebar();
    await renderChoroplethMap();
    renderSeatHistogram();
    renderTippingPointPills();
    renderRacesTable();
    setupEventListeners();

  } catch (err) {
    console.error("Failed to initialize Senate Forecast Dashboard:", err);
    const banner = document.getElementById("chamber-spectrum-bar");
    if (banner) {
      banner.innerHTML = `<div class="w-full h-full bg-amber-100 text-amber-900 flex items-center justify-center px-4 text-xs font-semibold">⚠️ ${err.message}</div>`;
    }
  }
}

// ---------------------------------------------------------
// 4. Render Top Banner & Chamber Spectrum Bar
// ---------------------------------------------------------
function renderTopBanner() {
  const cc = simData.chamber_control;
  const meta = simData.metadata;

  document.getElementById("dem-majority-prob").textContent = `${(cc.p_dem_majority * 100).toFixed(1)}%`;
  const dem50El = document.getElementById("dem-50-prob");
  if (dem50El && cc.p_dem_50_plus !== undefined) dem50El.textContent = `${(cc.p_dem_50_plus * 100).toFixed(1)}% chance of ≥50 seats`;
  document.getElementById("gop-majority-prob").textContent = `${(cc.p_gop_majority * 100).toFixed(1)}%`;
  document.getElementById("dem-expected-seats").textContent = cc.expected_dem_seats.toFixed(1);
  document.getElementById("gop-expected-seats").textContent = cc.expected_gop_seats.toFixed(1);

  const trialsEl = document.getElementById("meta-trials");
  if (trialsEl && meta && meta.n_trials) {
    trialsEl.textContent = `${meta.n_trials.toLocaleString()} Trials`;
  }
  const gcbEl = document.getElementById("meta-gcb");
  if (gcbEl && meta && meta.generic_ballot_margin !== undefined) {
    gcbEl.textContent = `GCB: D+${meta.generic_ballot_margin.toFixed(1)}%`;
  }

  // Count seats across spectrum buckets (including 34 Dem baseline in Solid D and 31 GOP baseline in Solid R)
  const counts = {
    D_Solid: 34,
    D_Likely: 0,
    D_Lean: 0,
    D_Tilt: 0,
    I_Any: 0,
    R_Tilt: 0,
    R_Lean: 0,
    R_Likely: 0,
    R_Solid: 31
  };

  enrichedRaces.forEach(r => {
    const { leadingParty, tier } = r.classification;
    if (leadingParty === "IND") {
      counts.I_Any += 1;
    } else if (leadingParty === "DEM") {
      counts[`D_${tier}`] += 1;
    } else {
      counts[`R_${tier}`] += 1;
    }
  });

  const segments = [
    { key: "D_Solid", label: "Solid D (inc. 34 base)", count: counts.D_Solid, color: COLORS.DEM.Solid, textColor: "#ffffff" },
    { key: "D_Likely", label: "Likely D", count: counts.D_Likely, color: COLORS.DEM.Likely, textColor: "#ffffff" },
    { key: "D_Lean", label: "Lean D", count: counts.D_Lean, color: COLORS.DEM.Lean, textColor: "#ffffff" },
    { key: "D_Tilt", label: "Tilt D", count: counts.D_Tilt, color: COLORS.DEM.Tilt, textColor: "#0f172a" },
    { key: "I_Any", label: "Leading Ind", count: counts.I_Any, color: COLORS.IND.Lean, textColor: "#ffffff" },
    { key: "R_Tilt", label: "Tilt R", count: counts.R_Tilt, color: COLORS.GOP.Tilt, textColor: "#0f172a" },
    { key: "R_Lean", label: "Lean R", count: counts.R_Lean, color: COLORS.GOP.Lean, textColor: "#ffffff" },
    { key: "R_Likely", label: "Likely R", count: counts.R_Likely, color: COLORS.GOP.Likely, textColor: "#ffffff" },
    { key: "R_Solid", label: "Solid R (inc. 31 base)", count: counts.R_Solid, color: COLORS.GOP.Solid, textColor: "#ffffff" }
  ];

  const barEl = document.getElementById("chamber-spectrum-bar");
  barEl.innerHTML = "";

  segments.forEach(seg => {
    if (seg.count <= 0) return;
    const div = document.createElement("div");
    div.style.width = `${seg.count}%`;
    div.style.backgroundColor = seg.color;
    div.style.color = seg.textColor;
    div.className = "h-full flex items-center justify-center font-mono text-xs font-bold border-r border-white/20 last:border-r-0 transition-all duration-300";
    div.title = `${seg.label}: ${seg.count} seat${seg.count > 1 ? "s" : ""}`;
    if (seg.count >= 2) {
      div.textContent = seg.count;
    }
    barEl.appendChild(div);
  });

  // Update Flip Count Badge
  const flips = enrichedRaces.filter(r => r.isFlip);
  const flipNames = flips.map(r => `${r.state} (${r.classification.partyLabel})`).join(", ");
  const flipBadge = document.getElementById("flip-count-badge");
  flipBadge.textContent = flips.length > 0 ? `${flips.length} (${flipNames})` : "0";
}

// ---------------------------------------------------------
// 5. Render Statutory & Special Rules Watch Sidebar
// ---------------------------------------------------------
function renderStatutoryWatchSidebar() {
  const container = document.getElementById("statutory-watch-list");
  if (!container) return;

  const ga = enrichedRaces.find(r => r.state === "GA");
  const ak = enrichedRaces.find(r => r.state === "AK");
  const me = enrichedRaces.find(r => r.state === "ME");
  const ne = enrichedRaces.find(r => r.state === "NE");
  const mt = enrichedRaces.find(r => r.state === "MT");

  const items = [];

  if (ga) {
    items.push(`
      <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 space-y-1">
        <div class="flex items-center justify-between">
          <span class="font-bold text-slate-900">Georgia (&gt;50% Rule)</span>
          <span class="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-amber-100 text-amber-900 rounded">
            Runoff: ${(ga.runoff_prob * 100).toFixed(1)}%
          </span>
        </div>
        <p class="text-[11px] text-slate-600">
          Ossoff leads <strong class="font-mono">${formatSignedMargin(ga.median_margin, ga.dem_candidate)}</strong>. If margin &lt; 2.5% with Libertarian share, advances to Dec runoff.
        </p>
      </div>
    `);
  }

  if (ak && me) {
    items.push(`
      <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 space-y-1">
        <div class="flex items-center justify-between">
          <span class="font-bold text-slate-900">Alaska &amp; Maine RCV</span>
          <span class="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-blue-100 text-blue-900 rounded">
            Instant Runoff
          </span>
        </div>
        <p class="text-[11px] text-slate-600">
          <strong>AK:</strong> 94% major R1 share; minor conservative transfers favor Sullivan (<strong class="font-mono">${formatSignedMargin(ak.median_margin, ak.dem_candidate)}</strong>).<br>
          <strong>ME:</strong> 98% major R1 share; Jackson leads Collins <strong class="font-mono">${formatSignedMargin(me.median_margin, me.dem_candidate)}</strong>.
        </p>
      </div>
    `);
  }

  if (ne && mt) {
    items.push(`
      <div class="p-2.5 rounded-lg bg-purple-50/70 border border-purple-200/80 space-y-1">
        <div class="flex items-center justify-between">
          <span class="font-bold text-purple-950">Independent Challengers</span>
          <span class="px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-purple-200 text-purple-900 rounded">
            4 States
          </span>
        </div>
        <p class="text-[11px] text-purple-900/80">
          <strong>NE:</strong> Dan Osborn (${formatSignedMargin(ne.median_margin, ne.dem_candidate)}) •
          <strong>MT:</strong> Seth Bodnar (${formatSignedMargin(mt.median_margin, mt.dem_candidate)}, 3-way split) • plus ID &amp; SD.
        </p>
      </div>
    `);
  }

  container.innerHTML = items.join("");
}

// ---------------------------------------------------------
// 6. Render D3 Choropleth Map with Flip Hatch Pattern
// ---------------------------------------------------------
async function renderChoroplethMap() {
  const svg = d3.select("#senate-map-svg");
  svg.selectAll("*").remove();

  // Define diagonal SVG hatch pattern for party flips + drop shadow filter
  const defs = svg.append("defs");

  const pattern = defs.append("pattern")
    .attr("id", "flip-hatch")
    .attr("patternUnits", "userSpaceOnUse")
    .attr("width", 8)
    .attr("height", 8)
    .attr("patternTransform", "rotate(45)");

  pattern.append("line")
    .attr("x1", 0)
    .attr("y1", 0)
    .attr("x2", 0)
    .attr("y2", 8)
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 2.8)
    .attr("stroke-opacity", 0.72);

  // Fetch US Albers-projected TopoJSON from US-Atlas CDN
  const usTopo = await d3.json("https://cdn.jsdelivr.net/npm/us-atlas@3/states-albers-10m.json");
  const statesGeo = topojson.feature(usTopo, usTopo.objects.states).features;

  const pathGenerator = d3.geoPath();
  const raceByState = {};
  enrichedRaces.forEach(r => { raceByState[r.state] = r; });

  const gStates = svg.append("g").attr("class", "states-layer");

  // 1. Base colored state polygons
  gStates.selectAll("path.state-base")
    .data(statesGeo)
    .join("path")
    .attr("class", d => {
      const st = FIPS_TO_STATE[String(d.id).padStart(2, "0")];
      return `state-polygon state-base ${raceByState[st] ? "contested" : "uncontested"}`;
    })
    .attr("d", pathGenerator)
    .attr("fill", d => {
      const st = FIPS_TO_STATE[String(d.id).padStart(2, "0")];
      const race = raceByState[st];
      return race ? race.classification.color : COLORS.UNCONTESTED;
    })
    .on("mouseenter", function (event, d) {
      const st = FIPS_TO_STATE[String(d.id).padStart(2, "0")];
      const race = raceByState[st];
      if (race) {
        d3.select(this).raise();
        // Keep hatch and outline on top
        svg.selectAll(".state-hatch-overlay, .state-flip-border, .state-labels-layer").raise();
        showMapTooltip(event, st, race);
      } else if (st) {
        showUncontestedTooltip(event, st);
      }
    })
    .on("mousemove", function (event) {
      positionTooltip(event);
    })
    .on("mouseleave", function () {
      hideMapTooltip();
    });

  // 2. Diagonal Hatch Overlay for Projected Party Flips
  const flipFeatures = statesGeo.filter(d => {
    const st = FIPS_TO_STATE[String(d.id).padStart(2, "0")];
    return raceByState[st] && raceByState[st].isFlip;
  });

  svg.append("g")
    .attr("class", "state-hatch-overlay pointer-events-none")
    .selectAll("path")
    .data(flipFeatures)
    .join("path")
    .attr("d", pathGenerator)
    .attr("fill", "url(#flip-hatch)")
    .attr("stroke", "#0f172a")
    .attr("stroke-width", 1.8)
    .attr("stroke-linejoin", "round");

  // 3. State Postal Labels on Contested States
  const labelGroup = svg.append("g")
    .attr("class", "state-labels-layer pointer-events-none");

  statesGeo.forEach(d => {
    const st = FIPS_TO_STATE[String(d.id).padStart(2, "0")];
    const race = raceByState[st];
    if (!race) return;

    const centroid = pathGenerator.centroid(d);
    if (!centroid || isNaN(centroid[0]) || isNaN(centroid[1])) return;

    // Skip tiny Northeast states where centroid text clutters, or offset slightly
    const smallStates = ["RI", "DE", "MA", "NJ", "NH"];
    if (smallStates.includes(st)) return;

    const isLightBg = race.classification.tier === "Tilt";
    labelGroup.append("text")
      .attr("x", centroid[0])
      .attr("y", centroid[1] + 3)
      .attr("text-anchor", "middle")
      .attr("font-family", "JetBrains Mono, monospace")
      .attr("font-size", "10px")
      .attr("font-weight", "700")
      .attr("fill", isLightBg ? "#0f172a" : "#ffffff")
      .attr("paint-order", "stroke")
      .attr("stroke", isLightBg ? "#ffffff" : "#0f172a")
      .attr("stroke-width", isLightBg ? "2px" : "2.2px")
      .attr("stroke-opacity", 0.65)
      .text(st);
  });
}

// ---------------------------------------------------------
// 7. Interactive Hover Infobox (Tooltip)
// ---------------------------------------------------------
function showMapTooltip(event, st, race) {
  const tooltip = document.getElementById("map-tooltip");
  const { classification, isFlip } = race;
  const shares = computeVoteShares(st, race);

  const isInd = isIndependentCandidate(race.dem_candidate);
  const demClean = cleanCandidateName(race.dem_candidate);
  const gopClean = cleanCandidateName(race.gop_candidate);

  const demTagBg = isInd ? "bg-[#6e4c9e]" : "bg-[#2b6cb0]";
  const demTagText = isInd ? "I" : "D";
  const demShareColor = isInd ? "text-[#4c2882]" : "text-[#1a3a8a]";

  // Order candidates so projected leader is on top
  const demLeads = race.median_margin >= 0;
  const leaderName = demLeads ? demClean : gopClean;
  const leaderProb = (race.leaderWinProb * 100).toFixed(1);
  const leaderColorClass = demLeads
    ? (isInd ? "text-[#4c2882]" : "text-[#1a3a8a]")
    : "text-[#991b1b]";

  const rowDem = `
    <div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-b-0">
      <div class="flex items-center space-x-1.5">
        <span class="font-semibold text-slate-900">${demClean}</span>
        <span class="px-1.5 py-0.2 rounded text-[10px] font-bold text-white ${demTagBg}">${demTagText}</span>
        ${race.incumbent_party === "DEM" ? '<span class="text-[9px] uppercase font-mono px-1 bg-slate-100 text-slate-500 rounded">Inc</span>' : ""}
      </div>
      <span class="font-mono font-bold ${demShareColor}">${shares.demShare}%</span>
    </div>
  `;

  const rowGop = `
    <div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-b-0">
      <div class="flex items-center space-x-1.5">
        <span class="font-semibold text-slate-900">${gopClean}</span>
        <span class="px-1.5 py-0.2 rounded text-[10px] font-bold text-white bg-[#c53030]">R</span>
        ${race.incumbent_party === "GOP" ? '<span class="text-[9px] uppercase font-mono px-1 bg-slate-100 text-slate-500 rounded">Inc</span>' : ""}
      </div>
      <span class="font-mono font-bold text-[#991b1b]">${shares.gopShare}%</span>
    </div>
  `;

  const orderedCandidateRows = demLeads ? (rowDem + rowGop) : (rowGop + rowDem);

  // Statutory Callout Section (GA Runoff or AK/ME RCV)
  let statutoryHtml = "";
  if (st === "GA") {
    statutoryHtml = `
      <div class="mt-2 pt-2 border-t border-amber-200/80 bg-amber-50/70 -mx-3.5 px-3.5 py-1.5 text-[10px] text-amber-950">
        <div class="flex items-center justify-between font-bold">
          <span>⚖️ Georgia &gt;50% Runoff Rule</span>
          <span class="font-mono bg-amber-200/80 px-1.5 py-0.5 rounded">${(race.runoff_prob * 100).toFixed(1)}% Runoff</span>
        </div>
        <div class="text-amber-800 mt-0.5">
          Requires &gt;50% to avoid Dec runoff (triggers if |Margin| &lt; 2.5%).
        </div>
      </div>
    `;
  } else if (shares.isRCV) {
    statutoryHtml = `
      <div class="mt-2 pt-2 border-t border-blue-200/80 bg-blue-50/60 -mx-3.5 px-3.5 py-1.5 text-[10px] text-slate-800 space-y-1">
        <div class="flex items-center justify-between font-bold text-blue-950">
          <span>🗳️ ${RCV_STATUTORY_META[st].system}</span>
          <span class="font-mono bg-blue-200/70 px-1.5 py-0.2 rounded">R1 Minor: ${shares.minorShare}%</span>
        </div>
        <div class="flex items-center justify-between font-mono text-[10px] pt-0.5">
          <span class="text-slate-600">Final RCV Round:</span>
          <span>
            <strong class="${demShareColor}">${demClean.split(" ").pop()} ${shares.demFinal}%</strong>
            vs
            <strong class="text-[#991b1b]">${gopClean.split(" ").pop()} ${shares.gopFinal}%</strong>
          </span>
        </div>
      </div>
    `;
  } else if (st === "MT") {
    statutoryHtml = `
      <div class="mt-2 pt-1.5 border-t border-purple-200 bg-purple-50/60 -mx-3.5 px-3.5 py-1 text-[10px] text-purple-950">
        <strong>3-Way Ballot Note:</strong> Includes 7.0% coalition split drag from Dem line (Bankhead).
      </div>
    `;
  }

  const badgeTextColor = classification.tier === "Tilt" ? "#0f172a" : "#ffffff";

  tooltip.innerHTML = `
    <!-- Header: State Name & Incumbent Tag -->
    <div class="flex items-center justify-between gap-2 pb-1.5 border-b border-slate-100">
      <div>
        <div class="font-extrabold text-sm text-slate-900 leading-tight">${race.state_name} Senate</div>
        <div class="text-[10px] font-medium text-slate-400">${race.region} • ${(race.is_open_seat === true || race.is_open_seat === "True") ? `Open (${race.incumbent_party} Held)` : `${race.incumbent_party} Incumbent`}</div>
      </div>
      <div class="flex items-center space-x-1">
        ${isFlip ? '<span class="px-1.5 py-0.5 text-[10px] font-extrabold uppercase bg-slate-900 text-white rounded">FLIP</span>' : ""}
        <span class="px-2 py-0.5 rounded text-[11px] font-bold shadow-sm" style="background-color: ${classification.color}; color: ${badgeTextColor}">
          ${classification.label}
        </span>
      </div>
    </div>

    <!-- Win Probability Callout -->
    <div class="py-1.5 text-xs font-bold ${leaderColorClass}">
      ${leaderName} has a ${leaderProb}% chance to win.
    </div>

    <!-- Candidate Share Table -->
    <div class="mt-0.5">
      <div class="flex justify-between text-[9px] font-bold uppercase tracking-wider text-slate-400 pb-0.5 border-b border-slate-100">
        <span>Candidate</span>
        <span>${shares.isRCV ? "R1 Est. Share" : "Est. Share"}</span>
      </div>
      ${orderedCandidateRows}
    </div>

    <!-- Expected Margin & 80% CI Row -->
    <div class="mt-2 pt-1.5 border-t border-slate-100 flex items-center justify-between text-[11px]">
      <span class="font-bold uppercase tracking-wider text-slate-400 text-[10px]">Exp. Margin (μ_s):</span>
      <div class="font-mono">
        <strong class="${leaderColorClass}">${formatSignedMargin(race.median_margin, race.dem_candidate)}</strong>
        <span class="text-[10px] text-slate-400 ml-1">[80% CI: ${formatSignedMargin(race.ci_80[0], race.dem_candidate)} to ${formatSignedMargin(race.ci_80[1], race.dem_candidate)}]</span>
      </div>
    </div>

    <!-- Compact Structural Context Bar: PVI, 2024 Pres, Spend -->
    <div class="mt-2 pt-1.5 border-t border-slate-100 grid grid-cols-3 gap-1 text-center bg-slate-50 rounded-lg p-1.5 text-[10px]">
      <div>
        <div class="text-slate-400 font-semibold">Voter Index</div>
        <div class="font-mono font-bold text-slate-700">${formatPVI(race.cook_pvi)}</div>
      </div>
      <div class="border-x border-slate-200/80 px-1">
        <div class="text-slate-400 font-semibold">2024 Pres</div>
        <div class="font-mono font-bold text-slate-700">${formatPres2024(race.pres_2024)}</div>
      </div>
      <div>
        <div class="text-slate-400 font-semibold">Total Spend</div>
        <div class="font-mono font-bold text-slate-700">$${race.total_spend_m.toFixed(1)}M</div>
      </div>
    </div>

    ${statutoryHtml}
  `;

  tooltip.classList.remove("hidden");
  positionTooltip(event);
}

function showUncontestedTooltip(event, st) {
  const tooltip = document.getElementById("map-tooltip");
  const stName = STATE_NAMES_FULL[st] || st;
  const vi = voterIndexMap[st] || {};

  tooltip.innerHTML = `
    <div class="flex items-center justify-between pb-1.5 border-b border-slate-100">
      <span class="font-bold text-sm text-slate-900">${stName}</span>
      <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-200 text-slate-700">No Race in 2026</span>
    </div>
    <p class="text-[11px] text-slate-500 mt-1.5">
      Class I &amp; Class III Senate seats in ${stName} are not up for election this cycle (part of the 34D–31R baseline).
    </p>
    <div class="mt-2 pt-1.5 border-t border-slate-100 flex justify-between text-[10px] font-mono text-slate-600">
      <span>Voter Index: <strong>${formatPVI(vi.pvi)}</strong></span>
      <span>2024 Pres: <strong>${formatPres2024(vi.margin_2024)}</strong></span>
    </div>
  `;
  tooltip.classList.remove("hidden");
  positionTooltip(event);
}

function positionTooltip(event) {
  const tooltip = document.getElementById("map-tooltip");
  if (tooltip.classList.contains("hidden")) return;

  const pad = 16;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;

  if (x + rect.width > window.innerWidth - 12) {
    x = event.clientX - rect.width - pad;
  }
  if (y + rect.height > window.innerHeight - 12) {
    y = event.clientY - rect.height - pad;
  }
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function hideMapTooltip() {
  const tooltip = document.getElementById("map-tooltip");
  tooltip.classList.add("hidden");
}

// ---------------------------------------------------------
// 8. Render Seat Distribution Histogram (Fixed & Responsive)
// ---------------------------------------------------------
function renderSeatHistogram() {
  const dist = simData?.chamber_control?.seat_distribution || {};
  const ci = simData?.chamber_control?.dem_seats_80_ci || [48, 53];

  // Update credible interval badge to live simulation numbers (48 – 53 seats)
  const ciBadge = document.getElementById("hist-ci-badge");
  if (ciBadge) {
    ciBadge.textContent = `${ci[0]} – ${ci[1]} seats`;
  }

  // Parse and filter relevant seat counts
  const data = Object.keys(dist)
    .map(k => ({ seats: Number(k), prob: Number(dist[k]) }))
    .filter(d => d.seats >= 42 && d.seats <= 58)
    .sort((a, b) => a.seats - b.seats);

  if (!data.length) return;

  const svg = d3.select("#histogram-svg");
  svg.selectAll("*").remove();

  // Define clear viewport
  const width = 800;
  const height = 250;
  const margin = { top: 25, right: 25, bottom: 40, left: 50 };

  svg
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("display", "block")
    .style("width", "100%")
    .style("height", "auto");

  // X scale (Seats)
  const x = d3.scaleBand()
    .domain(data.map(d => d.seats))
    .range([margin.left, width - margin.right])
    .padding(0.22);

  // Y scale (Probability)
  const maxProb = d3.max(data, d => d.prob) || 0.22;
  const y = d3.scaleLinear()
    .domain([0, maxProb * 1.18])
    .range([height - margin.bottom, margin.top]);

  // Grid lines
  svg.append("g")
    .attr("class", "grid")
    .attr("transform", `translate(${margin.left},0)`)
    .call(
      d3.axisLeft(y)
        .ticks(4)
        .tickSize(-(width - margin.left - margin.right))
        .tickFormat("")
    )
    .selectAll("line")
    .attr("stroke", "#e2e8f0")
    .attr("stroke-dasharray", "2,2");

  // Histogram Bars
  svg.append("g")
    .selectAll("rect")
    .data(data)
    .join("rect")
    .attr("x", d => x(d.seats))
    .attr("y", d => y(d.prob))
    .attr("width", x.bandwidth())
    .attr("height", d => Math.max(0, height - margin.bottom - y(d.prob)))
    .attr("rx", 3)
    .attr("fill", d => d.seats >= 51 ? "#1a3a8a" : (d.seats === 50 ? "#4299e1" : "#c53030"))
    .attr("opacity", d => (d.seats >= ci[0] && d.seats <= ci[1]) ? 0.95 : 0.40)
    .append("title")
    .text(d => `${d.seats} Dem/Ind Seats (${100 - d.seats} GOP): ${(d.prob * 100).toFixed(1)}%`);

  // Top percentage labels
  svg.append("g")
    .selectAll("text.prob-label")
    .data(data.filter(d => d.prob >= 0.015))
    .join("text")
    .attr("class", "prob-label")
    .attr("x", d => x(d.seats) + x.bandwidth() / 2)
    .attr("y", d => y(d.prob) - 6)
    .attr("text-anchor", "middle")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "9.5px")
    .attr("font-weight", "600")
    .attr("fill", "#475569")
    .text(d => `${(d.prob * 100).toFixed(1)}%`);

  // 50/51 Majority Line
  const x50 = x(50);
  if (x50 !== undefined) {
    const lineX = x50 + x.bandwidth() / 2;
    svg.append("line")
      .attr("x1", lineX)
      .attr("x2", lineX)
      .attr("y1", margin.top - 10)
      .attr("y2", height - margin.bottom)
      .attr("stroke", "#0f172a")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "4,3");

    svg.append("text")
      .attr("x", lineX + 6)
      .attr("y", margin.top + 2)
      .attr("font-size", "10px")
      .attr("font-weight", "700")
      .attr("fill", "#0f172a")
      .text("50/51 Majority Threshold →");
  }

  // X Axis
  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).tickSizeOuter(0))
    .selectAll("text")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px");

  // Y Axis
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d => `${(d * 100).toFixed(0)}%`))
    .selectAll("text")
    .attr("font-family", "JetBrains Mono, monospace")
    .attr("font-size", "10px");
}

// ---------------------------------------------------------
// 9. Render Tipping-Point Battleground Pills
// ---------------------------------------------------------
function renderTippingPointPills() {
  const row = document.getElementById("tipping-pills-row");
  if (!row) return;

  const topTipping = [...enrichedRaces]
    .sort((a, b) => b.tipping_point_prob - a.tipping_point_prob)
    .slice(0, 7);

  row.innerHTML = topTipping.map(r => {
    const textColor = r.classification.tier === "Tilt" ? "#0f172a" : "#ffffff";
    return `
      <div class="inline-flex items-center space-x-2 px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 text-xs">
        <span class="px-1.5 py-0.5 rounded font-mono font-bold text-[10px]" style="background-color: ${r.classification.color}; color: ${textColor}">
          ${r.state}
        </span>
        <span class="font-semibold text-slate-800">${formatSignedMargin(r.median_margin, r.dem_candidate)}</span>
        <span class="text-[11px] font-mono text-slate-500">Tip: ${(r.tipping_point_prob * 100).toFixed(1)}%</span>
      </div>
    `;
  }).join("");
}

// ---------------------------------------------------------
// 10. Render Interactive Sortable & Filterable Table
// ---------------------------------------------------------
function renderRacesTable() {
  const tbody = document.getElementById("races-table-body");
  const searchQuery = (document.getElementById("race-search-input")?.value || "").toLowerCase().trim();
  const regionFilter = document.getElementById("region-filter-select")?.value || "ALL";
  const compFilter = document.getElementById("competitive-filter-select")?.value || "ALL";

  let filtered = enrichedRaces.filter(r => {
    if (regionFilter !== "ALL" && r.region !== regionFilter) return false;
    if (compFilter === "COMPETITIVE" && Math.abs(r.median_margin) >= 12.0) return false;
    if (compFilter === "FLIPS" && !r.isFlip) return false;
    if (compFilter === "IND" && !isIndependentCandidate(r.dem_candidate)) return false;

    if (searchQuery) {
      const hay = `${r.state} ${r.state_name} ${r.dem_candidate} ${r.gop_candidate}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  // Sort
  const { key, asc } = currentSort;
  filtered.sort((a, b) => {
    let valA, valB;
    if (key === "state_name" || key === "region") {
      valA = a[key];
      valB = b[key];
      return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else if (key === "rating") {
      valA = a.median_margin;
      valB = b.median_margin;
    } else if (key === "win_prob") {
      valA = a.leaderWinProb;
      valB = b.leaderWinProb;
    } else {
      valA = a[key] !== null && a[key] !== undefined ? a[key] : -999;
      valB = b[key] !== null && b[key] !== undefined ? b[key] : -999;
    }
    return asc ? valA - valB : valB - valA;
  });

  tbody.innerHTML = filtered.map(r => {
    const isInd = isIndependentCandidate(r.dem_candidate);
    const demClean = cleanCandidateName(r.dem_candidate);
    const gopClean = cleanCandidateName(r.gop_candidate);
    const badgeTextColor = r.classification.tier === "Tilt" ? "#0f172a" : "#ffffff";
    const marginColor = r.median_margin >= 0
      ? (isInd ? "text-[#4c2882]" : "text-[#1a3a8a]")
      : "text-[#991b1b]";

    let specialBadge = "";
    if (r.state === "GA") {
      specialBadge = `<span class="ml-1.5 px-1.5 py-0.5 text-[9px] font-mono bg-amber-100 text-amber-900 rounded" title="December Runoff Probability">Runoff ${(r.runoff_prob * 100).toFixed(0)}%</span>`;
    } else if (r.state === "AK" || r.state === "ME") {
      specialBadge = `<span class="ml-1.5 px-1.5 py-0.5 text-[9px] font-mono bg-blue-100 text-blue-900 rounded">RCV</span>`;
    }

    return `
      <tr class="hover:bg-slate-50/90 transition">
        <td class="py-3 px-4 font-bold text-slate-900 whitespace-nowrap">
          <div class="flex items-center">
            <span>${r.state_name}</span>
            <span class="ml-1.5 text-[10px] font-mono text-slate-400">(${r.incumbent_party})</span>
            ${r.isFlip ? '<span class="ml-1.5 px-1.5 py-0.2 bg-slate-900 text-white text-[9px] font-mono uppercase rounded">Flip</span>' : ""}
            ${specialBadge}
          </div>
        </td>
        <td class="py-3 px-3 text-slate-500">${r.region}</td>
        <td class="py-3 px-4">
          <div class="flex items-center space-x-1.5">
            <span class="w-2 h-2 rounded-full ${isInd ? 'bg-[#6e4c9e]' : 'bg-[#2b6cb0]'}"></span>
            <span class="${r.median_margin >= 0 ? 'font-bold text-slate-900' : 'text-slate-600'}">${demClean}</span>
            ${isInd ? '<span class="px-1 py-0.2 text-[9px] font-mono bg-purple-100 text-purple-900 rounded font-semibold">Ind</span>' : ""}
          </div>
        </td>
        <td class="py-3 px-4">
          <div class="flex items-center space-x-1.5">
            <span class="w-2 h-2 rounded-full bg-[#c53030]"></span>
            <span class="${r.median_margin < 0 ? 'font-bold text-slate-900' : 'text-slate-600'}">${gopClean}</span>
          </div>
        </td>
        <td class="py-3 px-3 text-right font-mono text-slate-600">${formatPVI(r.cook_pvi)}</td>
        <td class="py-3 px-3 text-right font-mono text-slate-600">${formatPres2024(r.pres_2024)}</td>
        <td class="py-3 px-3 text-center">
          <span class="inline-block px-2 py-0.5 rounded text-[10px] font-bold shadow-sm" style="background-color: ${r.classification.color}; color: ${badgeTextColor}">
            ${r.classification.label}
          </span>
        </td>
        <td class="py-3 px-3 text-right font-mono font-bold ${marginColor}">
          ${formatSignedMargin(r.median_margin, r.dem_candidate)}
        </td>
        <td class="py-3 px-3 text-right font-mono font-semibold text-slate-800">
          ${(r.leaderWinProb * 100).toFixed(1)}%
        </td>
        <td class="py-3 px-3 text-right font-mono text-slate-600">
          ${(r.tipping_point_prob * 100).toFixed(1)}%
        </td>
        <td class="py-3 px-4 text-right font-mono text-slate-600">
          $${r.total_spend_m.toFixed(1)}M
        </td>
      </tr>
    `;
  }).join("");
}

// ---------------------------------------------------------
// 11. Event Listeners & Navigation
// ---------------------------------------------------------
function setupEventListeners() {
  // Table Sorting
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const sortKey = th.getAttribute("data-sort");
      if (currentSort.key === sortKey) {
        currentSort.asc = !currentSort.asc;
      } else {
        currentSort.key = sortKey;
        currentSort.asc = sortKey === "state_name" || sortKey === "region";
      }
      renderRacesTable();
    });
  });

  // Table Filters
  ["race-search-input", "region-filter-select", "competitive-filter-select"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", renderRacesTable);
      el.addEventListener("change", renderRacesTable);
    }
  });

  // Top Navigation Tabs Smooth Scroll
  document.querySelectorAll(".nav-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-nav");
      const section = document.getElementById(`section-${target}`);
      if (section) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  const mobileMethodBtn = document.getElementById("mobile-method-btn");
  if (mobileMethodBtn) {
    mobileMethodBtn.addEventListener("click", () => {
      document.getElementById("section-methodology")?.scrollIntoView({ behavior: "smooth" });
    });
  }

  // Sidebar View Buttons
  const btnMap = document.getElementById("btn-view-map");
  const btnHist = document.getElementById("btn-view-hist");
  if (btnMap && btnHist) {
    btnMap.addEventListener("click", () => {
      document.getElementById("card-map-view")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    btnHist.addEventListener("click", () => {
      document.getElementById("card-hist-view")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
}

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", initDashboard);
