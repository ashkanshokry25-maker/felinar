#!/usr/bin/env python3
# w2b-04: local-differential-privacy accuracy tables (stdlib only). Run: python3 -I ldp.py [--simulate]
# Binary randomized response (Warner 1965): report the truth with p = e^eps/(1+e^eps), else flip.
#   estimator  pi_hat = (lambda_hat - (1-p)) / (2p-1),  Var = lambda(1-lambda) / (n (2p-1)^2),  lambda = pi p + (1-pi)(1-p)
# Generalized randomized response (k categories): p = e^eps/(e^eps+k-1), q = 1/(e^eps+k-1)
#   Var(noise) = q(1-q)/(n(p-q)^2) + f(1-p-q)/(n(p-q))   (+ f(1-f)/n finite-population sampling term for a fresh population)
import math, random, statistics, sys

def rr_hw(eps, n, pi):
    p = math.exp(eps) / (1 + math.exp(eps)); lam = pi * p + (1 - pi) * (1 - p)
    return p, 1.96 * math.sqrt(lam * (1 - lam) / (n * (2 * p - 1) ** 2))

def grr_total_hw(eps, n, f, k):
    e = math.exp(eps); p = e / (e + k - 1); q = 1 / (e + k - 1)
    var = q * (1 - q) / (n * (p - q) ** 2) + f * (1 - p - q) / (n * (p - q)) + f * (1 - f) / n
    return p, q, 1.96 * math.sqrt(var)

def n_needed(eps, pi, hw):
    p = math.exp(eps) / (1 + math.exp(eps)); lam = pi * p + (1 - pi) * (1 - p)
    return 1.96 ** 2 * lam * (1 - lam) / ((2 * p - 1) ** 2 * hw ** 2)

NS = [100, 1000, 10000, 100000]
print('Binary RR, true rate 20%: 95% CI half-width in percentage points')
print('eps    p(truth)   ' + '  '.join(f'n={n:>7,}' for n in NS))
for eps in [math.log(3), 2.0, 4.0, 8.0]:
    print(f'{eps:4.2f}  {rr_hw(eps, 100, .2)[0]:7.3f}   ' + '  '.join(f'{rr_hw(eps, n, .2)[1] * 100:9.2f}' for n in NS))
print('\nBinary RR, true rate 5% (rare event such as ICE failure)')
for eps in [math.log(3), 2.0, 4.0]:
    print(f'{eps:4.2f}  ' + '  '.join(f'{rr_hw(eps, n, .05)[1] * 100:9.2f}' for n in NS))
print()
for eps in [math.log(3), 2.0, 4.0]:
    print(f'eps={eps:.2f}: n for +/-5pp (rate 20%): {n_needed(eps, .2, .05):,.0f}; +/-2pp: {n_needed(eps, .2, .02):,.0f}   (no noise, +/-5pp: {1.96 ** 2 * .16 / .05 ** 2:,.0f})')
print('\nGRR k=8 categories, one category at 10%: total 95% CI half-width (pp)')
for eps in [math.log(3), 2.0, 4.0]:
    p, q, _ = grr_total_hw(eps, 100, .1, 8)
    print(f'{eps:4.2f}  p={p:.3f}  ' + '  '.join(f'{grr_total_hw(eps, n, .1, 8)[2] * 100:9.2f}' for n in NS))
print('no noise      ' + '  '.join(f'{1.96 * math.sqrt(.1 * .9 / n) * 100:9.2f}' for n in NS))

if '--simulate' in sys.argv:
    random.seed(7)
    print('\nMonte Carlo check of the binary RR formula (n=1000, rate 20%, 1500 trials):')
    for eps in [math.log(3), 2.0]:
        p = math.exp(eps) / (1 + math.exp(eps)); n = 1000; pi = .2; est = []
        for _ in range(1500):
            cnt = 0
            for _ in range(n):
                v = random.random() < pi; r = v if random.random() < p else (not v); cnt += r
            est.append((cnt / n - (1 - p)) / (2 * p - 1))
        lam = pi * p + (1 - pi) * (1 - p); fs = math.sqrt(lam * (1 - lam) / (n * (2 * p - 1) ** 2))
        print(f'  eps={eps:.2f}: simulated sd {statistics.pstdev(est) * 100:.3f} pp vs formula {fs * 100:.3f} pp')
