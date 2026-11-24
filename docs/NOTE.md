# MediTrail – one-page note

*Fill in the contract address after deploying.*

**1. The user and their one task**
Sara, a pharmacy customer (fictional), scans the QR code on a box of insulin. In seconds, with no wallet or
account, she gets one verdict decided by the contract: *Genuine and safe*, *Genuine, still on its way*,
*Already sold once* (its code may have been copied), *Do not use: temperature breach*, *Recalled*, *Expired* or
*Unknown code*. Behind her, a manufacturer, a distributor and a pharmacy each record their own steps with their
own wallets, and a health regulator approves them.

**2. On the blockchain**
Approved companies and sensors with their roles and licence end dates. For each box: code, medicine, batch,
expiry, stage, manufacturer, current holder, the company a handover is waiting for, the fingerprint of the current
one-time seal code, the attached sensor, the fingerprint of the batch certificate, lowest and highest temperature
and a Compromised flag. Its append-only history (Registered, Offered, Received, Rejected, Temperature breach, Sold,
Recalled, Correction) with signing wallet, role, time and block number. Every signed temperature reading.
Recalled batches with reason. The verdict itself is computed on chain. Nothing is ever edited or deleted.

**3. Only on the page**
Turning the verdict number into words and colours, company names next to wallet addresses, the temperature
chart, QR codes and printable labels, generating random seal codes, fingerprinting a PDF in the browser, the
explorer links for each step, friendly error messages, and the simulated sensor's key (demo only).
Certificates and paper seal codes never leave the companies.

**4. What the contract refuses**
Approvals by anyone but the regulator; any step from a company whose licence has expired; registering by a
non-manufacturer, a duplicate code or an unapproved sensor; handovers out of order (manufacturer → distributor →
pharmacy only) or by anyone but the holder; acceptance by anyone but the named company or with a wrong seal code;
temperature readings not signed by the box's own sensor, or older than the last one; moving or selling a box after a
temperature breach or in a recalled batch; selling twice, selling a box the pharmacy never accepted, or selling after
expiry; recalls by anyone but the regulator or the batch's maker; corrections by a wallet that never handled the box.

**5. How to run it**
Open https://meditrail-s4rc.onrender.com. The *Check a box* tab needs no wallet: try `INS-0001`.
To record steps: MetaMask on Base Sepolia → *Company* tab → Connect. Contract: [0x93d65cDAFeA8856608d2Ce1eB05326A5C159EF87](https://sepolia.basescan.org/address/0x93d65cDAFeA8856608d2Ce1eB05326A5C159EF87) on Base Sepolia.
Demo transactions: register INS-0001 [0x29669a5bc4a7b27d81cfa2fb13304ecf9bddb5926b48d3a2787fd2a7629cd56e](https://sepolia.basescan.org/tx/0x29669a5bc4a7b27d81cfa2fb13304ecf9bddb5926b48d3a2787fd2a7629cd56e); accept INS-0001 with its seal code [0x115130143f3234fa29734e9f32b36f04061922dcd3c98b373c1f87429ed1bf5a](https://sepolia.basescan.org/tx/0x115130143f3234fa29734e9f32b36f04061922dcd3c98b373c1f87429ed1bf5a).
Local: `cd web && python -m http.server 8000`. Tests: `python -m pytest test/ -q` (20) and `npm run e2e` (33 checks).

**6. Path to real life**
A shared spreadsheet has one owner who can quietly change any row, and anyone with access can type "received"
for a box they never held. Here each step needs the right company's signature, the physical seal code and, for
temperature, the sensor's own signature; nobody can edit history. For real use: a health regulator holds the admin
role (it could complement the UAE's Tatmeen platform), sealed data loggers replace the simulated sensor, QR codes
follow the GS1 standard pharmacy scanners already read, the regulator sponsors network fees, and only serial
numbers and fingerprints go on chain: no patient or prescription data, ever.
