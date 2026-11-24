# Demo day: setup and the 5-minute pitch

## Demo state on Base Sepolia (set up 24 Nov 2026)

Contract `0x93d65cDAFeA8856608d2Ce1eB05326A5C159EF87`. Approved: Gulf Pharma Labs (manufacturer), Desert Logistics
(distributor), Al Noor Pharmacy (pharmacy), sensors S-01 (`0x43cf…3A2F`, key not on the demo laptop) and S-02
(`0x189F…E8e3`, key in the demo laptop's browser: run the demo from that Chrome profile).

| Box | Batch | Sensor | State | Used for |
|---|---|---|---|---|
| `INS-0001` | B-2611 | S-01 | At Al Noor Pharmacy, not sold | "Genuine and safe" + certificate match |
| `INS-0002` | B-2611 | S-01 | Offered to Desert Logistics | Live refusals: wrong wallet, wrong seal, then accept |
| `INS-0003` | B-2700 | S-01 | With Desert Logistics | Live recall of batch B-2700 |
| `INS-0004` | B-2611 | S-01 | Sold | "Already sold once" (copied code) |
| `INS-0005` | B-2611 | S-02 | With Desert Logistics, 3 normal readings | Live heat breach, then blocked hand-over |

Seal codes are on paper only (never in this repo). Certificate: `certificate-B-2611.pdf`; edited copy: `certificate-EDITED.pdf`.

- [ ] MetaMask Base Sepolia RPC set to `https://base-sepolia-rpc.publicnode.com` (the default public RPC rate-limits).
- [ ] Every wallet has a little test ETH (Coinbase CDP faucet).
- [ ] QR labels for `INS-0001` and `INS-0004` printed from the published site.

## Pitch (aim for 4:30)

1. **0:00–0:40 The problem.** At least 1 in 10 medicines in low- and middle-income countries is substandard or falsified (WHO). Up to half of vaccines are wasted, much of it through broken cold chains. Sara, holding a box of insulin, has no way to tell.
2. **0:40–1:10 Why ordinary blockchain fails.** It stores what people type. A copied QR code still says "Genuine". A typed "5 °C" is trusted blindly.
3. **1:10–3:30 Live demo.**
   1. Phone scans `INS-0001` → **Genuine and safe**, signed journey, temperature chart.
   2. Pharmacy laptop tries to accept `INS-0002` → **refused: This box was not offered to you** (wrong wallet).
   3. Distributor types a wrong seal code → **refused: Seal code does not match**. Then the real code from the card → accepted, proof link.
   4. Sensor tab: tap **Heat 11.2 °C** for `INS-0005` → box blocked. Distributor tries to hand it to the pharmacy → **refused**. Phone check `INS-0005` → red **Do not use**.
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
