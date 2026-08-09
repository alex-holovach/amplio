# Security

## Reporting

Email security concerns to the maintainers via GitHub Security Advisories on this repository:

https://github.com/alex-holovach/amplio/security/advisories/new

Please do not open public issues for undisclosed vulnerabilities.

## Tokens

Never commit npm or Vercel tokens. CI uses GitHub Actions environment secrets (`npm-publish`) and repository secrets for Vercel deploys.
