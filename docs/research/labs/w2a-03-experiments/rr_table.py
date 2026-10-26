import math
# Binary randomized response (Warner 1965 / k-RR with k=2). Each visitor reports truth with prob p = e^eps/(e^eps+1), else flips.
# Estimator: pi_hat = (r - (1-p)) / (2p-1); Var(pi_hat) = r(1-r) / (n (2p-1)^2), r = pi p + (1-pi)(1-p).
def se(eps, n, pi):
    p = math.exp(eps) / (math.exp(eps) + 1)
    r = pi * p + (1 - pi) * (1 - p)
    return math.sqrt(r * (1 - r) / n) / (2 * p - 1), p
print('binary RR, true proportion pi=0.10 (e.g., "did visitor use feature X"), 95% CI half-width = 1.96*SE, in percentage points')
print('eps   p_truth   n=100   n=1k   n=10k   n=100k   n=1M')
for eps in (0.5, 1.0, math.log(3), 2.0, 4.0):
    row = []
    for n in (100, 1000, 10000, 100000, 1000000):
        s, p = se(eps, n, 0.10)
        row.append(f'{1.96*s*100:6.2f}')
    print(f'{eps:4.2f}  {p:6.3f}   ' + '  '.join(row))
print()
print('pi=0.50 worst-case')
for eps in (1.0, math.log(3), 2.0):
    row = []
    for n in (100, 1000, 10000, 100000):
        s, p = se(eps, n, 0.50)
        row.append(f'{1.96*s*100:6.2f}')
    print(f'{eps:4.2f}  {p:6.3f}   ' + '  '.join(row))
# n needed for +/-1 percentage point at 95% for pi=0.1
print()
for eps in (1.0, math.log(3), 2.0, 4.0):
    p = math.exp(eps) / (math.exp(eps) + 1)
    r = 0.1 * p + 0.9 * (1 - p)
    n = (1.96**2) * r * (1 - r) / ((2 * p - 1) ** 2) / (0.01 ** 2)
    print(f'eps={eps:4.2f}: n for +/-1pp (95%, pi=0.10) = {n:,.0f}')
# non-private baseline for comparison
print('no-privacy baseline n for +/-1pp at pi=0.10:', f'{(1.96**2)*0.1*0.9/(0.01**2):,.0f}')
