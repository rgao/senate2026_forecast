"""
scripts/simulate.py

Phase 4 & 5 Cholesky Monte Carlo Simulation Engine (Bulletproof)
- Compatibility alias for JSON null/true/false literals.
- Safe type-casting helper safe_float() preventing TypeError on null/None values.
- Fixes Ghost Incumbency: Only awards +/- 2.5% incumbency advantage if the running candidate
  is an actual incumbent Senator (dem_office_tier == 'SENATOR' or gop_office_tier == 'SENATOR'
  matching incumbent_party). Open seats receive 0.0 incumbency bonus.
- Incorporates the +8.8% Dem Generic Congressional Ballot (GCB) national environment scaled by
  state elasticity into structural fundamentals:
    fund_margin = cook_pvi + (gcb_margin * elasticity) + inc_bonus + tier_offset + pen_offset
- Blends calibrated battleground polling composites (85% Poll / 15% Fundamentals).
- Runs 40,000 correlated Cholesky Monte Carlo trials across the 35x35 covariance matrix.
- Exports complete projections and metadata to docs/data/sim_results.json.
"""

import json
import math
import os
from datetime import datetime
from pathlib import Path
import numpy as np

# ---------------------------------------------------------
# 0. JSON / Python Compatibility Aliases
# ---------------------------------------------------------
# Prevents NameError if 'null', 'true', or 'false' are encountered in dynamic evaluations
null = None
true = True
false = False

def safe_float(val, default=0.0):
    """Safely converts values (including None, 'null', NaN, empty string) to float."""
    if val is None or val == "" or str(val).strip().lower() in ("null", "none", "nan"):
        return default
    try:
        f = float(val)
        return default if math.isnan(f) else f
    except (ValueError, TypeError):
        return default

# ---------------------------------------------------------
# 1. Project Directory Anchor & Paths
# ---------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent if SCRIPT_DIR.name == "scripts" else SCRIPT_DIR

DATA_DIR = PROJECT_ROOT / "data"
ENVIRONMENT_PATH = DATA_DIR / "environment.json"
RACE_MARGINS_PATH = DATA_DIR / "race_margins.json"
DOCS_DATA_DIR = PROJECT_ROOT / "docs" / "data"
SIM_RESULTS_PATH = DOCS_DATA_DIR / "sim_results.json"

# ---------------------------------------------------------
# 2. Simulation Parameters
# ---------------------------------------------------------
N_TRIALS = 40_000
DEFAULT_GCB_MARGIN = 8.8   # National Generic Ballot environment (D+8.8%)
SIGMA_NAT = 2.0            # National polling error std dev (%)
SIGMA_REGION = 1.5         # Regional cluster correlation std dev (%)

OFFICE_TIER_SCORES = {
    "SENATOR": 2.5,
    "GOVERNOR": 2.5,
    "US_REP": 1.5,
    "STATEWIDE": 1.5,
    "STATE_LEG": 0.5,
    "PARTY_CHAIR": 0.5,
    "CELEBRITY": 0.0,
    "FIRST_TIME": -0.5,
    "NONE": 0.0
}

# ---------------------------------------------------------
# 3. Expected Margin (mu) & Idiosyncratic Sigma Construction
# ---------------------------------------------------------
def compute_race_mu_and_sigma(race_info, gcb_margin=8.8):
    pvi = float(race_info.get("cook_pvi") or 0.0)
    elasticity = float(race_info.get("elasticity") or 1.0)
    inc_party = str(race_info.get("incumbent_party") or "OPEN").strip().upper()
    
    d_tier = str(race_info.get("dem_office_tier") or "FIRST_TIME").strip().upper()
    g_tier = str(race_info.get("gop_office_tier") or "FIRST_TIME").strip().upper()
    
    # Strict Incumbency: 0.0% in open seats like NC, MI, TX, NH, MT
    if inc_party == "DEM" and d_tier == "SENATOR":
        inc_bonus = 2.5
    elif inc_party == "GOP" and g_tier == "SENATOR":
        inc_bonus = -2.5
    else:
        inc_bonus = 0.0  # Open seat!
        
    tier_offset = OFFICE_TIER_SCORES.get(d_tier, 0.0) - OFFICE_TIER_SCORES.get(g_tier, 0.0)
    d_pen = float(race_info.get("dem_penalty") or 0.0)
    g_pen = float(race_info.get("gop_penalty") or 0.0)
    pen_offset = -d_pen + g_pen
    
    # 8.8% National Environment Shift
    env_shift = gcb_margin * elasticity
    
    # Structural Fundamentals Margin
    fund_margin = pvi + env_shift + inc_bonus + tier_offset + pen_offset
    
    # Blend with polling composite if available (85% Poll / 15% Fund)
    raw_poll = race_info.get("poll_composite_margin")
    if raw_poll is not None:
        expected_mu = 0.85 * float(raw_poll) + 0.15 * fund_margin
    else:
        expected_mu = fund_margin
        
    has_running_incumbent = (inc_bonus != 0.0)
    idio_sigma = 2.5 if has_running_incumbent else 4.0
    
    return round(expected_mu, 3), round(fund_margin, 2), inc_bonus, idio_sigma

# ---------------------------------------------------------
# 4. Covariance Matrix & Cholesky Factorization
# ---------------------------------------------------------
def build_covariance_matrix(states, races_data, idio_sigmas):
    K = len(states)
    Sigma = np.zeros((K, K))
    regions = [races_data[st].get("region", "National") for st in states]
    
    for i in range(K):
        for j in range(K):
            cov = SIGMA_NAT ** 2
            if regions[i] == regions[j]:
                cov += SIGMA_REGION ** 2
            if i == j:
                cov += idio_sigmas[i] ** 2
            Sigma[i, j] = cov
            
    jitter = 1e-6
    for attempt in range(5):
        try:
            L = np.linalg.cholesky(Sigma + np.eye(K) * jitter)
            return Sigma, L
        except np.linalg.LinAlgError:
            jitter *= 10
            
    raise RuntimeError("Failed to compute Cholesky decomposition of covariance matrix.")

# ---------------------------------------------------------
# 5. Statutory Post-Processing & Seat Allocation
# ---------------------------------------------------------
def evaluate_statutory_winner(state, sim_margin, rules):
    system = str(rules.get("system") or "PLURALITY").strip().upper()
    
    if system == "PLURALITY":
        winner = "DEM" if sim_margin > 0 else "GOP"
        return winner, False
        
    if system == "MAJORITY_RUNOFF":
        threshold = safe_float(rules.get("runoff_margin_threshold"), 2.5)
        if abs(sim_margin) < threshold:
            provisional = "DEM" if sim_margin > 0 else "GOP"
            return provisional, True
        else:
            winner = "DEM" if sim_margin > 0 else "GOP"
            return winner, False
            
    if system in ("RCV", "RCV_TOP4"):
        first_major = safe_float(rules.get("first_choice_share_major"), 0.95)
        
        dem_round1 = (0.50 + sim_margin / 200.0) * first_major
        gop_round1 = (0.50 - sim_margin / 200.0) * first_major
        minor_pool = max(0.0, 1.0 - first_major)
        
        if dem_round1 > 0.50:
            return "DEM", False
        if gop_round1 > 0.50:
            return "GOP", False
            
        exhaust_rate = safe_float(rules.get("minor_exhaust_rate"), 0.12)
        active_minor = minor_pool * (1.0 - exhaust_rate)
        
        if system == "RCV_TOP4": # Alaska
            gop_transfer = safe_float(rules.get("gop_second_choice_flow"), 0.75)
            dem_final = dem_round1 + active_minor * (1.0 - gop_transfer)
            gop_final = gop_round1 + active_minor * gop_transfer
        else: # Maine
            dem_transfer = safe_float(rules.get("dem_second_choice_flow"), 0.55)
            dem_final = dem_round1 + active_minor * dem_transfer
            gop_final = gop_round1 + active_minor * (1.0 - dem_transfer)
            
        winner = "DEM" if dem_final >= gop_final else "GOP"
        return winner, False
        
    winner = "DEM" if sim_margin > 0 else "GOP"
    return winner, False

# ---------------------------------------------------------
# 6. Master Simulation Pipeline
# ---------------------------------------------------------
def main():
    print("=" * 65)
    print(" 2026 SENATE FORECASTING PIPELINE — MONTE CARLO SIMULATION")
    print("=" * 65)
    print(f"[simulate] Project root: {PROJECT_ROOT}")
    
    # Try multiple paths for race_margins.json to ensure resilience
    race_margins_file = RACE_MARGINS_PATH
    if not race_margins_file.exists():
        candidates = [
            PROJECT_ROOT / "data" / "race_margins.json",
            PROJECT_ROOT / "race_margins.json",
            Path("data/race_margins.json"),
            Path("race_margins.json")
        ]
        for c in candidates:
            if c.exists():
                race_margins_file = c
                break
                
    if not race_margins_file.exists():
        raise FileNotFoundError(f"Missing race margins file: {race_margins_file}. Run scripts/ingest.py first.")
        
    with open(race_margins_file, "r") as f:
        payload = json.load(f)
        
    nat_env = payload.get("national_environment", {})
    gcb_margin = safe_float(nat_env.get("generic_ballot_margin"), DEFAULT_GCB_MARGIN)
    baseline = payload.get("uncontested_baseline", {"dem_held": 34, "gop_held": 31, "total_uncontested": 65})
    races_data = payload.get("races", {})
    
    states = sorted(list(races_data.keys()))
    K = len(states)
    print(f"[simulate] Loaded {K} contested races | GCB: D+{gcb_margin:.1f}% | Baseline: {baseline['dem_held']}D / {baseline['gop_held']}R.")
    
    # 1. Build Mu vector and Sigma diagonal
    mus = np.zeros(K)
    fund_margins = np.zeros(K)
    inc_bonuses = np.zeros(K)
    idio_sigmas = np.zeros(K)
    for idx, st in enumerate(states):
        mu_val, fund_val, inc_b, sig_val = compute_race_mu_and_sigma(races_data[st], gcb_margin)
        mus[idx] = mu_val
        fund_margins[idx] = fund_val
        inc_bonuses[idx] = inc_b
        idio_sigmas[idx] = sig_val
        
    # 2. Build Covariance & Cholesky Factor L
    Sigma, L = build_covariance_matrix(states, races_data, idio_sigmas)
    print(f"[simulate] Covariance matrix ({K}x{K}) constructed. Cholesky factor computed.")
    
    # 3. Monte Carlo Vectorized Generation: Y = mu + L @ Z
    print(f"[simulate] Generating {N_TRIALS:,} correlated multivariate normal trials...")
    np.random.seed(2026)
    Z = np.random.standard_normal((K, N_TRIALS))
    simulated_margins = mus[:, np.newaxis] + (L @ Z)
    
    # 4. Process Trials
    dem_baseline = int(baseline.get("dem_held", 34))
    win_matrix = np.zeros((K, N_TRIALS), dtype=np.int8)
    runoff_flags = np.zeros((K, N_TRIALS), dtype=np.bool_)
    
    for i, st in enumerate(states):
        rules = races_data[st].get("statutory_rules", {})
        margins_i = simulated_margins[i, :]
        
        system = str(rules.get("system") or "PLURALITY").strip().upper()
        if system == "PLURALITY":
            win_matrix[i, :] = (margins_i > 0).astype(np.int8)
        else:
            for t in range(N_TRIALS):
                w, is_run = evaluate_statutory_winner(st, margins_i[t], rules)
                win_matrix[i, t] = 1 if w == "DEM" else 0
                runoff_flags[i, t] = is_run
                
    dem_seats_per_trial = dem_baseline + np.sum(win_matrix, axis=0)
    gop_seats_per_trial = 100 - dem_seats_per_trial
    
    # 5. Chamber Control Probabilities
    p_dem_50_plus = float(np.mean(dem_seats_per_trial >= 50))
    p_dem_majority = float(np.mean(dem_seats_per_trial >= 51))
    p_gop_majority = float(np.mean(dem_seats_per_trial < 51))
    
    expected_dem_seats = round(float(np.mean(dem_seats_per_trial)), 2)
    expected_gop_seats = round(float(np.mean(gop_seats_per_trial)), 2)
    dem_seats_ci_80 = [int(np.percentile(dem_seats_per_trial, 10)), int(np.percentile(dem_seats_per_trial, 90))]
    
    seat_distribution = {}
    for s in range(34, 66):
        cnt = int(np.sum(dem_seats_per_trial == s))
        seat_distribution[str(s)] = round(float(cnt / N_TRIALS), 4)
        
    # 6. Tipping Point Calculation (51st seat = 17th Dem win from contested seats)
    tipping_point_counts = np.zeros(K, dtype=int)
    for t in range(N_TRIALS):
        trial_margins = simulated_margins[:, t]
        sorted_indices = np.argsort(-trial_margins)
        tipping_idx = sorted_indices[17 - 1]
        tipping_point_counts[tipping_idx] += 1
        
    tipping_point_index = {states[i]: round(float(tipping_point_counts[i] / N_TRIALS), 4) for i in range(K)}
    
    # 7. State-by-State Summaries
    state_results = {}
    for i, st in enumerate(states):
        r_info = races_data[st]
        st_margins = simulated_margins[i, :]
        p_dem_win = round(float(np.mean(win_matrix[i, :])), 4)
        median_margin = round(float(np.median(st_margins)), 2)
        ci_80 = [round(float(np.percentile(st_margins, 10)), 2), round(float(np.percentile(st_margins, 90)), 2)]
        
        state_results[st] = {
            "state_name": r_info["state_name"],
            "dem_candidate": r_info["dem_candidate"],
            "gop_candidate": r_info["gop_candidate"],
            "incumbent_party": r_info["incumbent_party"],
            "is_open_seat": "True" if inc_bonuses[i] == 0.0 else "False",
            "incumbency_bonus": float(inc_bonuses[i]),
            "region": r_info["region"],
            "cook_pvi": safe_float(r_info.get("cook_pvi")),
            "elasticity": safe_float(r_info.get("elasticity"), 1.0),
            "poll_margin": r_info.get("poll_composite_margin"),
            "fundamentals_margin": float(fund_margins[i]),
            "total_spend_m": safe_float(r_info.get("total_spend_m")),
            "dem_win_prob": p_dem_win,
            "gop_win_prob": round(1.0 - p_dem_win, 4),
            "median_margin": median_margin,
            "ci_80": ci_80,
            "tipping_point_prob": tipping_point_index[st],
            "runoff_prob": round(float(np.mean(runoff_flags[i, :])), 4) if np.any(runoff_flags[i, :]) else 0.0,
            "projected_winner": r_info["dem_candidate"] if p_dem_win >= 0.50 else r_info["gop_candidate"]
        }
        
    # 8. Assemble Full Output JSON
    output_payload = {
        "metadata": {
            "generated_at": datetime.now().isoformat(),
            "n_trials": N_TRIALS,
            "reference_election_date": "2026-11-03",
            "generic_ballot_margin": gcb_margin,
            "uncontested_baseline": baseline
        },
        "chamber_control": {
            "p_dem_majority": round(p_dem_majority, 4),
            "p_dem_50_plus": round(p_dem_50_plus, 4),
            "p_gop_majority": round(p_gop_majority, 4),
            "p_dem_51_plus": round(p_dem_majority, 4),
            "expected_dem_seats": expected_dem_seats,
            "expected_gop_seats": expected_gop_seats,
            "dem_seats_80_ci": dem_seats_ci_80,
            "seat_distribution": seat_distribution
        },
        "state_projections": state_results
    }
    
    DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(SIM_RESULTS_PATH, "w") as f:
        json.dump(output_payload, f, indent=2)
        
    # Also save to root docs/data/ if different
    alt_out = PROJECT_ROOT / "docs" / "data" / "sim_results.json"
    if alt_out != SIM_RESULTS_PATH:
        alt_out.parent.mkdir(parents=True, exist_ok=True)
        with open(alt_out, "w") as f:
            json.dump(output_payload, f, indent=2)
            
    print(f"\n[SUCCESS] Simulation completed successfully!")
    print(f" - Output written to: {SIM_RESULTS_PATH}")
    print(f" - Chamber Odds (>=51 Outright Dem): Dem {p_dem_majority*100:.1f}% | GOP {p_gop_majority*100:.1f}% (Dem >=50: {p_dem_50_plus*100:.1f}%)")
    print(f" - Expected Seats: {expected_dem_seats} Dem / {expected_gop_seats} GOP (80% CI: {dem_seats_ci_80[0]} - {dem_seats_ci_80[1]})")

if __name__ == "__main__":
    main()
