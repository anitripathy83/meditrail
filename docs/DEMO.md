# Demo day: setup and the 5-minute pitch

## Before the pitch (do this the evening before)

- [ ] Contract deployed on Base Sepolia, address in `web/config.js`, site live on GitHub Pages.
- [ ] Regulator approved: Gulf Pharma Labs (manufacturer), Desert Logistics (distributor), Al Noor Pharmacy (pharmacy), and the sensor address shown in the Sensor tab of the laptop that will sign readings.
- [ ] Every company wallet has test ETH.
- [ ] Prepared boxes (batch `B-2611`, certificate `certificate-B-2611.pdf` attached):
  - `INS-0001`: full journey done, **not yet sold**, three normal readings (for "Genuine and safe").
  - `INS-0002`: registered and **offered to the distributor**, seal code written on a card (for the live refusals).
  - `INS-0004`: **sold** already (for "Already sold once").
  - `INS-0003` in batch `B-2700` (to recall live, or already recalled).
- [ ] QR labels for `INS-0001` and `INS-0004` printed from the published site.
- [ ] A copy of the certificate with one word changed (`certificate-EDITED.pdf`).
- [ ] Two laptops: one with the distributor wallet (+ sensor tab), one with the pharmacy wallet. A phone for the check page.
- [ ] Save the two transaction hashes for the form: register `INS-0001` and accept `INS-0001` with its seal code.

## Pitch (aim for 4:30)

1. **0:00–0:40 The problem.** At least 1 in 10 medicines in low- and middle-income countries is substandard or falsified (WHO). Up to half of vaccines are wasted, much of it through broken cold chains. Sara, holding a box of insulin, has no way to tell.
2. **0:40–1:10 Why ordinary blockchain fails.** It stores what people type. A copied QR code still says "Genuine". A typed "5 °C" is trusted blindly.
3. **1:10–3:30 Live demo.**
   1. Phone scans `INS-0001` → **Genuine and safe**, signed journey, temperature chart.
   2. Pharmacy laptop tries to accept `INS-0002` → **refused: This box was not offered to you** (wrong wallet).
   3. Distributor types a wrong seal code → **refused: Seal code does not match**. Then the real code from the card → accepted, proof link.
   4. Sensor tab: tap **Heat 11.2 °C** for `INS-0002` → box blocked. Distributor tries to hand it to the pharmacy → **refused**. Phone check → red **Do not use**.
   5. On the phone, choose the real certificate → *Matches*; the edited one → *Does not match*.
   6. Scan `INS-0004` → **Already sold once**: this is how copied codes are caught.
   7. (If time) Recall batch `B-2700` in one click → every box in it turns red.
4. **3:30–4:10 What makes it different.** Four defences against false claims: two-sided handovers, seal codes that prove possession, sensor-signed temperatures, certificate fingerprints. The rules live in the contract: the same refusals happen from Remix.
5. **4:10–4:30 Path to real life.** A health regulator holds the admin role; it complements a national system like Tatmeen; sealed data loggers; no patient data ever on chain.

## Likely questions

- **Why not a spreadsheet?** One owner can quietly edit any row, and it can't check a seal code or a sensor's signature. Here no company controls history and the rules run as code.
- **What stops a company lying?** The right wallet, the physical seal code and the sensor's signature. What's left is collusion, and then every false step is signed and permanent.
- **What if the carrier moves the sensor?** A physical attack no software can stop; real loggers are sealed inside the package.
- **Privacy?** Only box codes, batch data and fingerprints. No patient or prescription data, ever.
- **Who pays fees?** The regulator can sponsor them; the sensor never needs funds because the carrier relays its readings.
