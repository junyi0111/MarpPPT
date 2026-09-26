# Security policy

Do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting for this repository when it is enabled. Include the affected version, a concise impact description, and reproducible steps without uploading private user documents or presentation files.

The current hosted HTTP profile is not production-ready for conversation attachment transfer. Do not expose it publicly as a way to access local or conversation files.

## Known dependency advisory

The current production dependency tree includes `image-size@1.2.1` through `pptxgenjs@4.0.1`. GitHub Security Advisories [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) report denial-of-service issues in image parsers and currently list no published patched version. MarpPPT's input validation currently accepts PNG and JPEG; the vulnerable parser paths are not directly used by that validation flow, but the transitive package remains present. Treat this as an unresolved dependency risk, not as a passed security audit. Check the advisories and rerun `npm audit --omit=dev --audit-level=high` before each public release.
