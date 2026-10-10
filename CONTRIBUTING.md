# Contributing

Oracle Desk stays honest: every number on the desk comes from a real launch, a real Oracle verdict, or
a real on-chain quote. Changes should preserve that.

1. Fork the repository and create a focused branch.
2. Run `npm ci` and `npm test`.
3. Run the desk in paper mode and exercise the dashboard at 320px, 768px, and a desktop width.
4. Open a pull request describing what the desk now decides differently, and why.

Do not add simulated markets, synthetic launches, or fake API responses to the runtime. Anything that
signs or moves funds must stay behind live mode's explicit acknowledgement and the risk desk's caps.

This repository is exported one way from the three.ws monorepo (`satellites/oracle-desk`); accepted
changes are applied there and re-exported.
