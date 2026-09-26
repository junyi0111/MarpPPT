# Security policy

Do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository when it is enabled. If that option is unavailable, open a public issue requesting a private reporting channel without including vulnerability details. Include the affected version, a concise impact description, and reproducible steps only in the private report; do not upload private user documents or presentation files.

The current hosted HTTP profile is not production-ready for conversation attachment transfer. Do not expose it publicly as a way to access local or conversation files.

## Dependency advisory status

The current lockfile resolves `image-size@2.0.4` through an override of the `pptxgenjs@4.0.1` dependency. As of 2026-09-26, GitHub advisories [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) list affected versions through `2.0.2` and patched version `2.0.3`. The locked `2.0.4` is outside those listed affected ranges. This version comparison is not a complete dependency audit; rerun `npm audit --omit=dev --audit-level=high` before each release and review any new advisories.
