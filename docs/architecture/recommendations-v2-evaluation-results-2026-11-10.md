> **Superseded** by [`recommendations-v2-evaluation-results-2026-11-11.md`](./recommendations-v2-evaluation-results-2026-11-11.md),
> the same world and config re-run on the engines as fixed after the 2026-11-11 independent
> review. Kept as the record of what was measured on the code first submitted.

> **SYNTHETIC DATA.** Every number below comes from a generated world whose people, tastes and
> rankings are assumptions (`evaluation/world.ts`). It shows how the engines behave under that
> model. It is **not** evidence that any engine is better for real bingd readers.

Config `rec-eval-config-2026-11-10.1`, world `rec-eval-world-2026-11-10.1`, seed 20261110, 400 test readers.
Strata: mainstream 100, polyglot 60, minority 80, non_english 40, classic 40, niche 40, cold_start 40.
Each cell is a mean over readers ± a 95% normal-approximation interval; wall metrics average three launch seeds per reader.

### Engines, all readers

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V1 (shipping) | 0.037 ± 0.011 | 0.020 ± 0.005 | 0.213 ± 0.028 | 0.736 ± 0.006 | 0.053 ± 0.014 | 0.370 ± 0.061 | 0.041 ± 0.014 | 0.056 ± 0.007 | 11.80 ± 0.19 | 0.733 ± 0.007 |
| V2 metadata (A1) | 0.032 ± 0.011 | 0.018 ± 0.005 | 0.148 ± 0.024 | 0.732 ± 0.006 | 0.087 ± 0.016 | 0.525 ± 0.062 | 0.050 ± 0.016 | 0.054 ± 0.007 | 11.91 ± 0.21 | 0.735 ± 0.008 |
| V2 hybrid (A2) | 0.035 ± 0.011 | 0.019 ± 0.006 | 0.172 ± 0.025 | 0.733 ± 0.006 | 0.087 ± 0.016 | 0.527 ± 0.062 | 0.049 ± 0.016 | 0.054 ± 0.007 | 11.92 ± 0.21 | 0.738 ± 0.008 |

### Engines vs V1, paired differences, all readers

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | -0.005 ± 0.005 | -0.002 ± 0.003 | -0.064 ± 0.017 | -0.004 ± 0.003 | +0.034 ± 0.006 | +0.155 ± 0.036 | +0.009 ± 0.006 | -0.001 ± 0.003 | +0.11 ± 0.09 | +0.002 ± 0.003 |
| V2 hybrid (A2) | -0.003 ± 0.006 | -0.001 ± 0.003 | -0.040 ± 0.019 | -0.003 ± 0.003 | +0.034 ± 0.006 | +0.156 ± 0.037 | +0.008 ± 0.007 | -0.001 ± 0.003 | +0.13 ± 0.09 | +0.006 ± 0.003 |

### Engines vs V1, paired, stratum `mainstream`

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | +0.003 ± 0.007 | +0.003 ± 0.004 | -0.061 ± 0.035 | -0.001 ± 0.004 | +0.008 ± 0.003 | — | — | +0.001 ± 0.005 | +0.04 ± 0.15 | +0.004 ± 0.004 |
| V2 hybrid (A2) | +0.010 ± 0.014 | +0.005 ± 0.005 | -0.025 ± 0.037 | +0.001 ± 0.004 | +0.008 ± 0.003 | — | — | -0.000 ± 0.005 | +0.04 ± 0.15 | +0.008 ± 0.004 |

### Engines vs V1, paired, stratum `polyglot`

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | -0.003 ± 0.005 | +0.002 ± 0.004 | -0.056 ± 0.045 | +0.000 ± 0.006 | +0.069 ± 0.019 | +0.143 ± 0.046 | — | -0.002 ± 0.007 | +0.03 ± 0.18 | -0.006 ± 0.005 |
| V2 hybrid (A2) | +0.000 ± 0.004 | +0.004 ± 0.004 | -0.027 ± 0.053 | +0.002 ± 0.006 | +0.069 ± 0.019 | +0.141 ± 0.045 | — | -0.002 ± 0.006 | +0.09 ± 0.19 | -0.001 ± 0.005 |

### Engines vs V1, paired, stratum `minority`

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | -0.014 ± 0.018 | -0.006 ± 0.009 | -0.084 ± 0.047 | -0.006 ± 0.006 | +0.058 ± 0.014 | +0.204 ± 0.065 | — | -0.003 ± 0.007 | -0.02 ± 0.18 | -0.002 ± 0.006 |
| V2 hybrid (A2) | -0.013 ± 0.019 | -0.005 ± 0.010 | -0.053 ± 0.052 | -0.004 ± 0.006 | +0.057 ± 0.013 | +0.208 ± 0.067 | — | -0.003 ± 0.007 | -0.03 ± 0.18 | +0.002 ± 0.006 |

### Engines vs V1, paired, stratum `non_english`

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | -0.005 ± 0.027 | -0.003 ± 0.009 | -0.013 ± 0.021 | -0.000 ± 0.009 | +0.077 ± 0.028 | +0.075 ± 0.064 | — | -0.008 ± 0.008 | -0.06 ± 0.23 | -0.011 ± 0.012 |
| V2 hybrid (A2) | -0.005 ± 0.027 | -0.003 ± 0.009 | +0.012 ± 0.028 | -0.000 ± 0.010 | +0.074 ± 0.029 | +0.075 ± 0.064 | — | -0.008 ± 0.008 | -0.08 ± 0.23 | -0.007 ± 0.012 |

### Engines vs V1, paired, stratum `classic`

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | -0.007 ± 0.007 | -0.002 ± 0.004 | -0.051 ± 0.052 | +0.000 ± 0.005 | +0.012 ± 0.009 | — | +0.009 ± 0.006 | -0.006 ± 0.008 | +0.08 ± 0.25 | +0.002 ± 0.006 |
| V2 hybrid (A2) | -0.007 ± 0.007 | -0.002 ± 0.004 | -0.032 ± 0.058 | +0.001 ± 0.005 | +0.013 ± 0.009 | — | +0.008 ± 0.007 | -0.005 ± 0.008 | +0.12 ± 0.26 | +0.005 ± 0.006 |

### Engines vs V1, paired, stratum `niche`

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | -0.001 ± 0.010 | -0.003 ± 0.005 | -0.092 ± 0.070 | -0.001 ± 0.008 | +0.010 ± 0.007 | — | — | +0.001 ± 0.008 | -0.00 ± 0.24 | +0.002 ± 0.007 |
| V2 hybrid (A2) | -0.001 ± 0.010 | -0.003 ± 0.005 | -0.090 ± 0.071 | -0.001 ± 0.008 | +0.010 ± 0.007 | — | — | +0.002 ± 0.008 | +0.02 ± 0.25 | +0.005 ± 0.007 |

### Engines vs V1, paired, stratum `cold_start`

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata (A1) | -0.015 ± 0.016 | -0.009 ± 0.012 | -0.080 ± 0.026 | -0.028 ± 0.012 | +0.005 ± 0.005 | — | — | +0.007 ± 0.022 | +1.00 ± 0.37 | +0.029 ± 0.007 |
| V2 hybrid (A2) | -0.015 ± 0.016 | -0.009 ± 0.012 | -0.080 ± 0.026 | -0.028 ± 0.012 | +0.006 ± 0.005 | — | — | +0.007 ± 0.023 | +1.03 ± 0.38 | +0.030 ± 0.007 |

### Ablations and sweeps vs V2 metadata, paired, all readers

| Variant | Held-out recall@20 | Held-out nDCG@20 | Pool recall | Oracle utility pct | Non-English share | Open languages served | Era share (era readers) | Disliked-genre share | Distinct genres | Popularity pct |
|---|---|---|---|---|---|---|---|---|---|---|
| V2 metadata − language anchors | +0.000 ± 0.000 | +0.000 ± 0.000 | +0.000 ± 0.000 | +0.000 ± 0.000 | -0.001 ± 0.001 | -0.011 ± 0.008 | +0.000 ± 0.000 | +0.000 ± 0.000 | -0.00 ± 0.01 | -0.000 ± 0.000 |
| V2 metadata − catalogue fill | -0.000 ± 0.001 | -0.000 ± 0.000 | -0.004 ± 0.003 | +0.001 ± 0.001 | -0.000 ± 0.000 | -0.002 ± 0.004 | -0.001 ± 0.002 | +0.000 ± 0.001 | +0.02 ± 0.02 | +0.000 ± 0.000 |
| V2 metadata − era term | -0.001 ± 0.002 | -0.000 ± 0.001 | +0.000 ± 0.000 | +0.000 ± 0.001 | -0.001 ± 0.001 | -0.001 ± 0.008 | -0.005 ± 0.004 | -0.000 ± 0.001 | -0.02 ± 0.03 | -0.000 ± 0.001 |
| V2 metadata − negative evidence | -0.000 ± 0.001 | -0.000 ± 0.001 | -0.000 ± 0.002 | -0.000 ± 0.001 | -0.006 ± 0.001 | -0.006 ± 0.007 | -0.002 ± 0.004 | +0.000 ± 0.001 | +0.00 ± 0.03 | +0.001 ± 0.001 |
| V2 hybrid, collaborative source only (no term) | +0.000 ± 0.000 | +0.000 ± 0.000 | +0.024 ± 0.008 | +0.000 ± 0.000 | +0.000 ± 0.000 | +0.000 ± 0.000 | -0.000 ± 0.001 | +0.000 ± 0.000 | +0.00 ± 0.01 | +0.002 ± 0.000 |
| V2 hybrid, collaborative term only (no source) | +0.002 ± 0.002 | +0.001 ± 0.001 | +0.000 ± 0.000 | +0.001 ± 0.001 | -0.000 ± 0.001 | +0.002 ± 0.004 | -0.001 ± 0.001 | -0.000 ± 0.000 | +0.01 ± 0.01 | +0.003 ± 0.001 |
| V2 hybrid, collaborative weight 0.05 | +0.001 ± 0.001 | +0.000 ± 0.000 | +0.024 ± 0.008 | +0.000 ± 0.000 | -0.000 ± 0.000 | +0.000 ± 0.000 | -0.000 ± 0.001 | +0.000 ± 0.000 | +0.00 ± 0.01 | +0.003 ± 0.001 |
| V2 hybrid, collaborative weight 0.1 | +0.002 ± 0.002 | +0.001 ± 0.001 | +0.024 ± 0.008 | +0.001 ± 0.000 | -0.000 ± 0.000 | +0.000 ± 0.000 | -0.000 ± 0.001 | -0.000 ± 0.000 | +0.01 ± 0.01 | +0.003 ± 0.001 |
| V2 hybrid, collaborative weight 0.25 | +0.005 ± 0.003 | +0.002 ± 0.002 | +0.024 ± 0.008 | +0.003 ± 0.001 | -0.001 ± 0.001 | -0.006 ± 0.009 | -0.002 ± 0.002 | +0.001 ± 0.001 | +0.08 ± 0.03 | +0.007 ± 0.002 |
| V2 hybrid, collaborative weight 0.35 | +0.007 ± 0.004 | +0.004 ± 0.002 | +0.024 ± 0.008 | +0.006 ± 0.002 | -0.003 ± 0.002 | -0.010 ± 0.011 | -0.003 ± 0.004 | +0.004 ± 0.002 | +0.24 ± 0.07 | +0.012 ± 0.003 |
| V2 metadata, language weight 0.05 | +0.000 ± 0.001 | -0.000 ± 0.000 | +0.000 ± 0.000 | -0.001 ± 0.001 | +0.005 ± 0.001 | +0.010 ± 0.009 | +0.001 ± 0.002 | +0.000 ± 0.001 | -0.02 ± 0.02 | +0.000 ± 0.001 |
| V2 metadata, language weight 0.2 | +0.000 ± 0.001 | +0.000 ± 0.001 | +0.000 ± 0.000 | +0.001 ± 0.001 | -0.006 ± 0.002 | -0.004 ± 0.006 | -0.001 ± 0.004 | +0.001 ± 0.001 | +0.02 ± 0.02 | +0.000 ± 0.001 |
| V2 metadata, era weight 0.14 | +0.001 ± 0.001 | +0.000 ± 0.001 | +0.000 ± 0.000 | +0.000 ± 0.001 | +0.000 ± 0.001 | +0.004 ± 0.008 | +0.016 ± 0.010 | -0.000 ± 0.001 | -0.00 ± 0.03 | +0.000 ± 0.001 |

### Following

Giving every reader a different random follow graph changed the wall for 0/400 readers under V2 hybrid and 115/400 under V1.

### Catalogue coverage (distinct titles on first walls ÷ catalogue)

| Variant | Coverage |
|---|---|
| v1 | 0.411 |
| v2_metadata | 0.427 |
| v2_hybrid | 0.427 |
| v2m-no-language-anchors | 0.427 |
| v2m-no-catalogue | 0.425 |
| v2m-no-era | 0.425 |
| v2m-no-negatives | 0.417 |
| v2h-source-only | 0.427 |
| v2h-term-only | 0.427 |
| v2h-collab-0.05 | 0.427 |
| v2h-collab-0.1 | 0.426 |
| v2h-collab-0.25 | 0.426 |
| v2h-collab-0.35 | 0.422 |
| v2m-language-0.05 | 0.429 |
| v2m-language-0.2 | 0.415 |
| v2m-era-0.14 | 0.426 |

### Collaborative source (real SQL in PGlite)

139/400 readers received collaborative rows; mean 6.3 rows; mean neighbours 3.5; mean SQL time 94 ms per first (refreshing) call in single-connection PGlite, which is not production Postgres.

Client scoring cost per slate (JS, this machine): v1 1.0 ± 0.0 ms; v2_metadata 3.8 ± 0.1 ms; v2_hybrid 3.9 ± 0.1 ms.