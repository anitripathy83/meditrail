// MediTrail website. Plain JavaScript + ethers v6, no build step.
// - Reads go through the public Base Sepolia endpoint: no wallet needed.
// - Writes go through each company's own MetaMask, so every step is signed by that company.
// - Before every write the page asks the contract with a free simulated call, so a refusal
//   shows instantly in plain words. The page itself holds no business rules.

import { ethers } from "./vendor/ethers.min.js";
import qrcode from "./vendor/qrcode.mjs";
import { ABI } from "./abi.js";
import { CONFIG as BASE_CONFIG } from "./config.js";

// ------------------------------------------------------------------ config

const params = new URLSearchParams(location.search);
const CONFIG = { ...BASE_CONFIG };
const overrideAddress = params.get("contract");
if (overrideAddress && ethers.isAddress(overrideAddress)) CONFIG.contractAddress = overrideAddress;
const configured = ethers.isAddress(CONFIG.contractAddress || "");

const ROLE = ["Not approved", "Manufacturer", "Distributor", "Pharmacy", "Sensor"];
const STAGE = ["Not registered", "At manufacturer", "On the way to distributor", "With distributor",
  "On the way to pharmacy", "At pharmacy", "Sold"];
const ZERO = ethers.ZeroAddress;

// ------------------------------------------------------------------ small helpers

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const cleanId = (v) => String(v || "").trim().toUpperCase();
const cleanCode = (v) => String(v || "").trim().toUpperCase();
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const dateTime = (t) => new Date(Number(t) * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const dateOnly = (t) => new Date(Number(t) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const temp = (t) => `${(Number(t) / 10).toFixed(1)} °C`;
const addrLink = (a) => `<a class="mono" href="${CONFIG.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>`;
const txLink = (h, text) => `<a href="${CONFIG.explorer}/tx/${h}" target="_blank" rel="noopener">${esc(text || "Proof on the explorer")}</a>`;
const endOfDay = (yyyyMmDd) => Math.floor(Date.parse(`${yyyyMmDd}T23:59:59Z`) / 1000);
const isoDate = (d) => d.toISOString().slice(0, 10);

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage can be unavailable; the page still works */ }
  return value;
}

const readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
const reader = configured ? new ethers.Contract(CONFIG.contractAddress, ABI, readProvider) : null;

const wallet = { account: null, writer: null, member: null, active: false, isAdmin: false };
let directory = new Map(); // lower-case address -> { role, name, until }
let adminAddress = "";
const txLog = [];

// ------------------------------------------------------------------ directory of companies

async function loadDirectory() {
  if (!reader) return;
  const [wallets, members] = await reader.getMembers();
  directory = new Map();
  wallets.forEach((w, i) => directory.set(w.toLowerCase(), {
    address: w, role: Number(members[i].role), name: members[i].name, until: Number(members[i].licenceUntil),
  }));
  adminAddress = await reader.admin();
}

function who(addr) {
  if (!addr || addr === ZERO) return "";
  if (same(addr, adminAddress)) return "Health regulator";
  const m = directory.get(addr.toLowerCase());
  return m && m.name ? m.name : short(addr);
}

function activeMembers(role) {
  const now = Date.now() / 1000;
  return [...directory.values()].filter((m) => m.role !== 0 && m.until >= now && (role === undefined || m.role === role));
}

// ------------------------------------------------------------------ messages and errors

function showMsg(el, kind, title, body = "") {
  if (typeof el === "string") el = $(el);
  el.innerHTML = `<div class="msg ${kind}" role="status"><div class="title">${esc(title)}</div>${body ? `<div>${body}</div>` : ""}</div>`;
}

/** Turn any ethers / MetaMask error into one plain sentence. */
function friendlyError(err) {
  const text = (() => { try { return JSON.stringify(err, Object.getOwnPropertyNames(err || {})); } catch { return String(err); } })() || "";
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001 || /user (rejected|denied)/i.test(text)) {
    return { title: "Cancelled", body: "You cancelled the request in MetaMask. Nothing was recorded." };
  }
  if (err?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(text)) {
    return { title: "No test funds", body: "This wallet has no test ETH on Base Sepolia. Get free test funds from the faucet link the organisers shared." };
  }
  let reason = err?.reason || err?.revert?.args?.[0];
  if (!reason) {
    const m = text.match(/reverted(?: with reason string)?:? ?\\?['"]?([A-Z][^'"\\]{5,200})/);
    if (m) reason = m[1].trim();
  }
  if (reason) return { title: "The contract refused this step", body: esc(reason) + "." };
  if (err?.code === "NETWORK_ERROR" || /failed to fetch|network/i.test(text)) {
    return { title: "Network problem", body: "Cannot reach the Base Sepolia network. Check your connection and try again." };
  }
  return { title: "Something went wrong", body: esc(err?.shortMessage || err?.message || "Unknown error.") };
}

// ------------------------------------------------------------------ wallet

function renderWallet() {
  const html = !window.ethereum
    ? `<div class="wallet-box"><span>To sign steps you need the MetaMask browser extension (install it only from <a href="https://metamask.io" target="_blank" rel="noopener">metamask.io</a>).</span></div>`
    : !wallet.account
      ? `<div class="wallet-box"><span>Connect the wallet of the company you work for.</span><button class="primary" data-connect>Connect MetaMask</button></div>`
      : `<div class="wallet-box"><span><strong>${esc(wallet.isAdmin ? "Health regulator" : wallet.member?.name || "Unknown wallet")}</strong> · ${addrLink(wallet.account)}</span>
         <span>${wallet.isAdmin ? `<span class="pill ok">Regulator</span>` : ""}
         ${wallet.member && wallet.member.role !== 0
           ? `<span class="pill ${wallet.active ? "ok" : "no"}">${ROLE[wallet.member.role]} · ${wallet.active ? `licence to ${dateOnly(wallet.member.until)}` : "licence expired"}</span>`
           : wallet.isAdmin ? "" : `<span class="pill no">Not approved by the regulator</span>`}</span></div>`;
  $$(".wallet-slot").forEach((slot) => (slot.innerHTML = html));
  $$("[data-connect]").forEach((b) => b.addEventListener("click", connect));
}

async function connect() {
  if (!window.ethereum) return renderWallet();
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const [account] = await provider.send("eth_requestAccounts", []);
    await switchNetwork();
    const signer = await provider.getSigner(account);
    wallet.account = ethers.getAddress(account);
    wallet.writer = configured ? new ethers.Contract(CONFIG.contractAddress, ABI, signer) : null;
    await refreshWallet();
  } catch (err) {
    const e = friendlyError(err);
    $$(".wallet-slot").forEach((slot) => showMsg(slot, "err", e.title, e.body));
  }
}

async function switchNetwork() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CONFIG.chainIdHex }] });
  } catch (err) {
    if (err?.code === 4902 || /unrecognized chain/i.test(err?.message || "")) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: CONFIG.chainIdHex, chainName: CONFIG.chainName, rpcUrls: [CONFIG.rpcUrl],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [CONFIG.explorer],
      }] });
    } else throw err;
  }
}

async function refreshWallet() {
  if (!wallet.account || !reader) return renderWallet();
  await loadDirectory();
  const [member, active] = await reader.getMember(wallet.account);
  wallet.member = { role: Number(member.role), name: member.name, until: Number(member.licenceUntil) };
  wallet.active = active;
  wallet.isAdmin = same(wallet.account, adminAddress);
  renderWallet();
  fillSelects();
  renderMyBoxes();
}

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", () => { wallet.account = null; connect(); });
}

/** Simulate first (free, instant refusal), then send through MetaMask and wait. */
async function send(fn, args, msgEl, okTitle, okBody = "") {
  if (!configured) return showMsg(msgEl, "err", "No contract yet", "Set the contract address in web/config.js first.");
  if (!wallet.writer) {
    await connect();
    if (!wallet.writer) return showMsg(msgEl, "err", "Connect your wallet first", "Use the Connect MetaMask button above.");
  }
  const buttons = $$("button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    showMsg(msgEl, "wait", "Checking with the contract…");
    await wallet.writer[fn].staticCall(...args);
    showMsg(msgEl, "wait", "Confirm in MetaMask…", "The contract accepted the check. Approve the transaction to record it.");
    const tx = await wallet.writer[fn](...args);
    showMsg(msgEl, "wait", "Recording on the blockchain…", txLink(tx.hash, "Follow it on the explorer"));
    await tx.wait();
    txLog.unshift({ hash: tx.hash, what: okTitle, time: new Date() });
    renderTxLog();
    showMsg(msgEl, "ok", okTitle, `${okBody}${okBody ? " " : ""}${txLink(tx.hash)}`);
    refreshWallet().catch(() => {});
    return tx;
  } catch (err) {
    const e = friendlyError(err);
    showMsg(msgEl, "err", e.title, e.body);
    return null;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function renderTxLog() {
  $("#txlog").innerHTML = txLog.length
    ? txLog.map((t) => `<li>${esc(t.what)} · ${t.time.toLocaleTimeString("en-GB")} · ${txLink(t.hash, short(t.hash))}</li>`).join("")
    : `<li class="hint">Nothing yet.</li>`;
}

// ------------------------------------------------------------------ tabs and routing

function moveInk() {
  const active = $(".tab.active");
  const ink = $(".tab-ink");
  if (!active || !ink) return;
  ink.style.left = `${active.offsetLeft}px`;
  ink.style.width = `${active.offsetWidth}px`;
}

function showView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  moveInk();
  if (window.scrollY > 200) window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === "admin") renderAdminLists();
  if (name === "sensor") renderSensor();
  if (name === "company") renderMyBoxes();
}
$$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

function checkUrl(id) {
  const q = overrideAddress && configured ? `?contract=${CONFIG.contractAddress}` : "";
  return `${location.origin}${location.pathname}${q}#check=${encodeURIComponent(id)}`;
}

function qrImg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 8);
}

// ------------------------------------------------------------------ CHECK (public, no wallet)

async function findTxHashes(id, history) {
  // Each entry stores its block number, so we only ask for logs in that one block.
  const filter = reader.filters.Step(ethers.id(id));
  const byBlock = {};
  await Promise.all([...new Set(history.map((e) => Number(e.blockNo)))].map(async (b) => {
    try { byBlock[b] = await reader.queryFilter(filter, b, b); } catch { byBlock[b] = []; }
  }));
  const used = {};
  return history.map((e) => {
    const b = Number(e.blockNo);
    used[b] = used[b] || 0;
    const log = byBlock[b]?.[used[b]++];
    return log ? log.transactionHash : null;
  });
}

function verdictCard(v, box, history, recall) {
  const last = (kind) => [...history].reverse().find((e) => e.kind === kind);
  if (v === 0 || !box) return ["v-bad", "Unknown code", "No box with this code was ever registered. It may be fake: do not use it, and show it to a pharmacist."];
  const range = Number(box.readingCount) > 0 ? `kept between ${temp(box.minTemp)} and ${temp(box.maxTemp)} (${box.readingCount} signed readings)` : "no sensor readings yet";
  switch (v) {
    case 1: {
      const waiting = box.pendingTo !== ZERO ? ` A handover to ${esc(who(box.pendingTo))} is waiting to be accepted.` : "";
      return ["v-info", "Genuine, still on its way", `Registered by ${esc(who(box.manufacturer))}, now held by ${esc(who(box.holder))}; ${range}.${waiting} It has not reached a pharmacy yet.`];
    }
    case 2: return ["v-good", "Genuine and safe", `Made by ${esc(who(box.manufacturer))}, ${range}, now at ${esc(who(box.holder))}.`];
    case 3: {
      const sold = last("Sold");
      return ["v-warn", "Already sold once", `Sold by ${esc(who(box.holder))} on ${sold ? dateTime(sold.time) : "an earlier date"}. If that was your purchase, it is genuine. If someone is selling you this box now, its code may have been copied onto a fake.`];
    }
    case 4: {
      const b = last("Temperature breach");
      return ["v-bad", "Do not use: temperature breach", `${esc(b?.note || "A signed sensor reading was outside 2.0–8.0 °C")}. The medicine may no longer work, so the contract has blocked this box.`];
    }
    case 5: return ["v-bad", "Recalled: do not use", `Batch ${esc(box.batch)} was recalled by ${esc(who(recall.by))} on ${dateTime(recall.time)}: ${esc(recall.reason)}. Return it to a pharmacy.`];
    case 6: return ["v-bad", "Expired", `This box expired on ${dateOnly(box.expiry)}. Do not use it.`];
    default: return ["v-info", "Unknown status", ""];
  }
}

function tempChart(rows) {
  if (!rows.length) return `<p class="hint">No temperature readings yet.</p>`;
  const W = 360, H = 190, L = 34, R = 8, T = 14, B = 24;
  const lo = -50, hi = 150; // tenths of a degree: -5 to 15 C
  const x = (i) => L + (rows.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (rows.length - 1));
  const y = (t) => T + ((hi - Math.max(lo, Math.min(hi, t))) * (H - T - B)) / (hi - lo);
  const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(Number(r.temp)).toFixed(1)}`).join(" ");
  const ticks = [0, 20, 80, 120].map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t / 10}°</text>`).join("");
  const dots = rows.map((r, i) => {
    const t = Number(r.temp), bad = t < 20 || t > 80;
    return `<circle cx="${x(i)}" cy="${y(t)}" r="${bad ? 5 : 3.5}" class="${bad ? "bad" : "ok"}"><title>${temp(t)} at ${dateTime(r.takenAt)}</title></circle>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Signed temperature readings; safe band 2 to 8 degrees">
    <rect x="${L}" width="${W - L - R}" y="${y(80)}" height="${y(20) - y(80)}" class="band"/>${ticks}
    <text x="${W - R}" y="${y(80) - 4}" text-anchor="end" class="band-label">safe 2–8 °C</text>
    <polyline points="${pts}" class="line"/>${dots}
    <text x="${L}" y="${H - 6}">first reading</text><text x="${W - R}" y="${H - 6}" text-anchor="end">latest</text></svg>`;
}

const ICON_PATH = {
  "v-good": "M31 51 l12 12 l26 -27",
  "v-warn": "M50 27 v29 M50 72 v1",
  "v-bad": "M35 35 L65 65 M65 35 L35 65",
  "v-info": "M27 50 h40 m-14 -14 l14 14 l-14 14",
};
function verdictHtml(cls, word, text) {
  return `<div class="verdict ${cls}">
    <svg class="verdict-icon" viewBox="0 0 100 100" aria-hidden="true"><circle class="fill" cx="50" cy="50" r="45"/><circle class="ring" cx="50" cy="50" r="37"/><path d="${ICON_PATH[cls] || ""}"/></svg>
    <div><div class="word">${word}</div><p>${text}</p></div></div>`;
}

const KIND_CLASS = { Registered: "made", Offered: "offered", Received: "received", Rejected: "rejected",
  "Temperature breach": "breach", Sold: "sold", Recalled: "recalled", Correction: "correction" };

async function checkBox(rawId) {
  const id = cleanId(rawId);
  const out = $("#check-result");
  if (!id) return;
  $("#check-id").value = id;
  if (!reader) return showMsg(out, "err", "No contract yet", "The contract address is not set in web/config.js.");
  showMsg(out, "wait", `Checking ${id} on the blockchain…`);
  try {
    await loadDirectory();
    const [box, v] = await Promise.all([reader.getBox(id), reader.verdictOf(id)]);
    const verdict = Number(v);
    if (verdict === 0) {
      const [cls, word, text] = verdictCard(0);
      out.innerHTML = `${verdictHtml(cls, word, text)}`;
      return;
    }
    const [history, readings, recall] = await Promise.all([reader.getHistory(id), reader.getReadings(id), reader.getRecall(box.batch)]);
    const hashes = await findTxHashes(id, history);
    const [cls, word, text] = verdictCard(verdict, box, history, recall);
    const holderText = box.pendingTo !== ZERO ? `${who(box.holder)} → ${who(box.pendingTo)} (waiting)` : who(box.holder);
    out.innerHTML = `
      ${verdictHtml(cls, word, text)}
      <div class="facts">
        <div class="fact"><div class="k">Medicine</div><div class="v">${esc(box.medicine)}</div></div>
        <div class="fact"><div class="k">Box · batch</div><div class="v">${esc(box.id)} · ${esc(box.batch)}</div></div>
        <div class="fact"><div class="k">Expires</div><div class="v">${dateOnly(box.expiry)}</div></div>
        <div class="fact"><div class="k">Made by</div><div class="v">${esc(who(box.manufacturer))}</div></div>
        <div class="fact"><div class="k">${Number(box.stage) === 6 ? "Sold by" : "Now with"}</div><div class="v">${esc(holderText)}</div></div>
        <div class="fact"><div class="k">Temperature</div><div class="v">${Number(box.readingCount) ? `${temp(box.minTemp)} – ${temp(box.maxTemp)}` : "No readings"}</div></div>
      </div>
      <div class="card"><h2>Temperature, signed by the box's sensor</h2>${tempChart(readings)}
        <p class="hint">Sensor ${esc(who(box.sensor))} · ${addrLink(box.sensor)}. Each point carries the sensor's own signature, checked by the contract.</p></div>
      <div class="card"><h2>Journey</h2><p class="hint">Every step is signed by the company's own wallet and can never be edited.</p>
        <ol class="timeline">${history.map((e, i) => `
          <li class="${KIND_CLASS[e.kind] || ""}" style="--i:${i}">
            <div class="step">${esc(e.kind)}</div>
            <div class="who">${esc(who(e.by))}${Number(e.role) ? ` · ${ROLE[Number(e.role)]}` : ""} · <span class="when">${dateTime(e.time)}</span></div>
            ${e.note ? `<div class="note">${esc(e.note)}</div>` : ""}
            ${hashes[i] ? `<div class="note">${txLink(hashes[i])}</div>` : ""}
          </li>`).join("")}</ol></div>
      <div class="card"><h2>Check the batch certificate</h2>
        <p class="hint">Got the lab certificate PDF? Choose it here. Your browser computes its fingerprint and compares it with the one the manufacturer put on the blockchain. The file is never uploaded.</p>
        <input type="file" id="cert-file" aria-label="Certificate file"><div id="cert-msg"></div></div>
      <details class="card"><summary>Why can I trust this?</summary>
        <ul class="why">
          <li>Only companies approved by the health regulator, with a valid licence, can record steps.</li>
          <li>Each handover needs the receiving company to type a one-time code sealed inside the package, so nobody can claim a box they never held.</li>
          <li>Temperatures are signed by the sensor itself; the carrier cannot edit them. One reading outside 2–8 °C blocks the box for good.</li>
          <li>These rules run inside the smart contract, not this website. Anyone can verify it: ${addrLink(CONFIG.contractAddress)}.</li>
        </ul></details>
      <div class="qr"><img src="${qrImg(checkUrl(id))}" alt="QR code to check ${esc(id)}"><span class="hint">This QR code opens this check page for ${esc(id)}.</span></div>`;
    $$(".facts .fact", out).forEach((f, i) => f.style.setProperty("--i", i));
    $("#cert-file").addEventListener("change", (ev) => checkCertificate(id, ev.target.files[0]));
    out.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  } catch (err) {
    const e = friendlyError(err);
    showMsg(out, "err", e.title, e.body);
  }
}

async function fileFingerprint(file) {
  return ethers.keccak256(new Uint8Array(await file.arrayBuffer()));
}

async function checkCertificate(id, file) {
  if (!file) return;
  const fp = await fileFingerprint(file);
  const ok = await reader.checkCertificate(id, fp);
  showMsg("#cert-msg", ok ? "ok" : "err",
    ok ? "Matches the manufacturer's original" : "Does not match",
    ok ? `This is exactly the certificate registered for ${esc(id)}.` : "This file was altered, or it is not the certificate registered for this box.");
}

$$("[data-demo]").forEach((b) => b.addEventListener("click", () => checkBox(b.dataset.demo)));
$("#check-form").addEventListener("submit", (ev) => { ev.preventDefault(); checkBox($("#check-id").value); });

// ------------------------------------------------------------------ COMPANY

function fillSelects() {
  // Keep whatever the user already picked when the lists refresh in the background.
  const keepSensor = $("#reg-sensor").value;
  const keepTo = $("#offer-to").value;
  const sensors = activeMembers(4);
  $("#reg-sensor").innerHTML = sensors.length
    ? sensors.map((m) => `<option value="${m.address}">${esc(m.name)} (${short(m.address)})</option>`).join("")
    : `<option value="">No approved sensor yet</option>`;
  // All companies are listed on purpose: the contract, not the page, refuses the wrong one.
  const companies = activeMembers().filter((m) => m.role !== 4 && !same(m.address, wallet.account));
  $("#offer-to").innerHTML = companies.map((m) => `<option value="${m.address}">${esc(m.name)} · ${ROLE[m.role]}</option>`).join("")
    || `<option value="">No approved companies yet</option>`;
  if (keepSensor && [...$("#reg-sensor").options].some((o) => o.value === keepSensor)) $("#reg-sensor").value = keepSensor;
  if (keepTo && [...$("#offer-to").options].some((o) => o.value === keepTo)) $("#offer-to").value = keepTo;
}

$("#reg-cert").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  $("#reg-cert-hash").innerHTML = f ? `Fingerprint: <span class="mono">${short(await fileFingerprint(f))}</span>. Only this goes on the blockchain; the PDF stays with you.` : "Only the certificate's fingerprint goes on the blockchain.";
});

$("#reg-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = cleanId($("#reg-id").value);
  const file = $("#reg-cert").files[0];
  const certHash = file ? await fileFingerprint(file) : ethers.ZeroHash;
  const expiry = endOfDay($("#reg-expiry").value);
  const sensor = $("#reg-sensor").value || ZERO;
  $("#reg-qr").innerHTML = "";
  const tx = await send("registerBox", [id, $("#reg-name").value.trim(), $("#reg-batch").value.trim().toUpperCase(), expiry, sensor, certHash],
    "#reg-msg", `Box ${id} registered`, file ? "" : "No certificate was attached, so the certificate check will not be available.");
  if (tx) {
    $("#reg-qr").innerHTML = `<div class="qr label"><img src="${qrImg(checkUrl(id))}" alt="QR code for ${esc(id)}">
      <div><div class="label-id">${esc(id)}</div><div class="hint">Print this label and stick it on the box. Scanning it opens the public check page.</div>
      <button type="button" onclick="window.print()">Print label</button></div></div>`;
    $("#offer-id").value = id;
  }
});

function newSealCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

$("#offer-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = cleanId($("#offer-id").value);
  const to = $("#offer-to").value;
  const code = newSealCode();
  $("#offer-seal").innerHTML = "";
  const tx = await send("offer", [id, to, ethers.id(code), $("#offer-note").value.trim()],
    "#offer-msg", `Box ${id} offered to ${who(to)}`, `It stays your responsibility until they accept it.`);
  if (tx) {
    $("#offer-seal").innerHTML = `<div class="seal">
      <div class="hint">One-time seal code for ${esc(id)} → ${esc(who(to))}</div>
      <div class="seal-code" id="seal-code">${code}</div>
      <div class="hint">Print it, put it <strong>inside</strong> the tamper seal, then close the package. Do not send it by message. Only its fingerprint is on the blockchain.</div>
      <div class="actions"><button type="button" onclick="window.print()">Print seal slip</button></div></div>`;
  }
});

$("#accept-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = cleanId($("#accept-id").value);
  await send("accept", [id, cleanCode($("#accept-code").value)], "#accept-msg", `You received ${id}`, "The seal code matched. You are now responsible for this box.");
});

$("#reject-btn").addEventListener("click", async () => {
  const id = cleanId($("#accept-id").value);
  if (!id) return showMsg("#accept-msg", "err", "Enter the box code first");
  await send("reject", [id, $("#reject-reason").value.trim()], "#accept-msg", `You rejected ${id}`, "The sender keeps responsibility for the box. Your reason is now on its public record.");
});

$("#sell-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = cleanId($("#sell-id").value);
  await send("sell", [id], "#sell-msg", `${id} sold`, "The code is now used up: if it appears again, the check page will warn that it may be a copy.");
});

$("#corr-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = cleanId($("#corr-id").value);
  await send("addCorrection", [id, $("#corr-note").value.trim()], "#corr-msg", `Correction added to ${id}`, "The original entry is still there; this one sits on top of it.");
});

$("#recall-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const batch = $("#recall-batch").value.trim().toUpperCase();
  await send("recallBatch", [batch, $("#recall-reason").value.trim()], "#recall-msg", `Batch ${batch} recalled`, "Every box in it now shows Recalled on the check page and can no longer move or be sold.");
});

async function allBoxes() {
  const ids = await reader.getBoxIds();
  return Promise.all(ids.map(async (id) => ({ id, box: await reader.getBox(id), verdict: Number(await reader.verdictOf(id)) })));
}

async function renderMyBoxes() {
  const el = $("#my-boxes");
  if (!reader || !wallet.account) return;
  try {
    const rows = (await allBoxes()).filter(({ box }) => same(box.holder, wallet.account) || same(box.pendingTo, wallet.account));
    el.innerHTML = rows.length ? `<table><tr><th>Box</th><th>Medicine</th><th>Status</th><th>Your next step</th></tr>${rows.map(({ id, box, verdict }) => {
      const waitingForMe = same(box.pendingTo, wallet.account);
      const stage = Number(box.stage);
      const blocked = verdict === 4 || verdict === 5;
      const next = blocked ? "Blocked" : waitingForMe ? "Accept with the seal code" : box.pendingTo !== ZERO ? `Waiting for ${esc(who(box.pendingTo))}` : stage === 5 ? "Sell" : stage === 6 ? "Done" : "Hand over";
      return `<tr><td class="mono">${esc(id)}</td><td>${esc(box.medicine)}</td><td>${STAGE[stage]}${blocked ? ` · <strong>${verdict === 4 ? "temperature breach" : "recalled"}</strong>` : ""}</td><td>${next}</td></tr>`;
    }).join("")}</table>` : `<p class="hint">No boxes with you right now.</p>`;
  } catch { el.textContent = "Could not load boxes."; }
}

// ------------------------------------------------------------------ SENSOR (simulated logger)

function sensorWallet() {
  let key = store("meditrail.sensorKey");
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) key = store("meditrail.sensorKey", ethers.Wallet.createRandom().privateKey);
  return new ethers.Wallet(key);
}
let sensor = sensorWallet();

async function renderSensor() {
  $("#sensor-addr").textContent = sensor.address;
  if (!reader) return;
  try {
    const [m, active] = await reader.getMember(sensor.address);
    $("#sensor-status").innerHTML = Number(m.role) === 4
      ? `<span class="pill ${active ? "ok" : "no"}">${active ? `Approved: ${esc(m.name)}` : "Approval expired"}</span>`
      : `<span class="pill no">Not approved yet</span>`;
  } catch { /* ignore */ }
}

$("#sensor-copy").addEventListener("click", () => navigator.clipboard?.writeText(sensor.address));
$("#sensor-new").addEventListener("click", () => {
  store("meditrail.sensorKey", ethers.Wallet.createRandom().privateKey);
  sensor = sensorWallet();
  renderSensor();
});
const tempInput = $("#sensor-temp");
function showTemp() {
  const t = Number(tempInput.value);
  const bad = t < 2 || t > 8;
  $("#sensor-temp-out").textContent = `${t.toFixed(1)} °C`;
  $("#gauge").dataset.state = bad ? "bad" : "ok";
  $("#gauge").style.setProperty("--t", `${((t + 5) / 20) * 100}%`);
  $("#gauge-state").textContent = bad ? (t > 8 ? "Too warm: this reading will block the box" : "Too cold: this reading will block the box") : "Inside the safe range";
}
tempInput.addEventListener("input", showTemp);
$$("[data-temp]").forEach((b) => b.addEventListener("click", () => { tempInput.value = b.dataset.temp; showTemp(); }));
showTemp();

$("#sensor-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const id = cleanId($("#sensor-box").value);
  const t = Math.round(Number(tempInput.value) * 10);
  if (!reader) return showMsg("#sensor-msg", "err", "No contract yet");
  const box = await reader.getBox(id);
  const takenAt = Math.max(Math.floor(Date.now() / 1000), Number(box.lastReadingAt) + 1);
  const inner = await reader.readingHash(id, t, takenAt);
  const signature = await sensor.signMessage(ethers.getBytes(inner));
  const breach = t < 20 || t > 80;
  await send("submitReading", [id, t, takenAt, signature], "#sensor-msg", `Reading ${temp(t)} recorded for ${id}`,
    breach ? "This is outside 2–8 °C: the box is now blocked for good." : "Inside the safe range.");
});

// ------------------------------------------------------------------ REGULATOR

$("#member-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const addr = $("#member-wallet").value.trim();
  if (!ethers.isAddress(addr)) return showMsg("#member-msg", "err", "That is not a wallet address", "It should start with 0x and have 42 characters.");
  const role = Number($("#member-role").value);
  const until = role === 0 ? 0 : endOfDay($("#member-until").value || isoDate(new Date(Date.now() + 365 * 864e5)));
  const name = $("#member-name").value.trim();
  await send("setMember", [ethers.getAddress(addr), role, name, until], "#member-msg",
    role === 0 ? "Approval removed" : `${name || short(addr)} approved as ${ROLE[role]}`);
  renderAdminLists();
});

async function renderAdminLists() {
  if (!reader) return;
  try {
    await loadDirectory();
    const now = Date.now() / 1000;
    const members = [...directory.values()];
    $("#member-list").innerHTML = members.length ? `<table><tr><th>Name</th><th>Role</th><th>Wallet</th><th>Licence</th></tr>${members.map((m) =>
      `<tr><td>${esc(m.name || "—")}</td><td>${ROLE[m.role]}</td><td>${addrLink(m.address)}</td><td>${m.role === 0 ? "Removed" : m.until >= now ? `Valid to ${dateOnly(m.until)}` : `<strong>Expired ${dateOnly(m.until)}</strong>`}</td></tr>`).join("")}</table>`
      : `<p class="hint">No companies approved yet.</p>`;
    const rows = await allBoxes();
    const word = ["Unknown", "In supply chain", "At pharmacy", "Sold", "Temperature breach", "Recalled", "Expired"];
    $("#box-list").innerHTML = rows.length ? `<table><tr><th>Box</th><th>Batch</th><th>Stage</th><th>With</th><th>Verdict</th></tr>${rows.map(({ id, box, verdict }) =>
      `<tr><td class="mono"><a href="#check=${encodeURIComponent(id)}">${esc(id)}</a></td><td>${esc(box.batch)}</td><td>${STAGE[Number(box.stage)]}</td><td>${esc(who(box.holder))}</td><td>${word[verdict]}</td></tr>`).join("")}</table>`
      : `<p class="hint">No boxes registered yet.</p>`;
  } catch (err) {
    const e = friendlyError(err);
    showMsg("#member-list", "err", e.title, e.body);
  }
}



// ------------------------------------------------------------------ the cold-chain map behind the page
// Behind every page is a night map of a city. A route runs Factory -> Distributor -> Pharmacy -> You.
// As you scroll, the route draws itself, a glowing medicine box travels along it with a live
// temperature reading, and each stop it reaches lights up as a signed block.

function seeded(seed) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }
const map = { built: null, route: null, live: null, len: 0, nodeLen: [], nodes: [], courier: null, temp: null };

function smoothPath(pts) {
  // Catmull-Rom through the stops, written as cubic Bezier curves.
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 5, p1[1] + (p2[1] - p0[1]) / 5];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 5, p2[1] - (p3[1] - p1[1]) / 5];
    d += ` C${c1[0].toFixed(0)} ${c1[1].toFixed(0)} ${c2[0].toFixed(0)} ${c2[1].toFixed(0)} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function buildMap() {
  const host = $("#scene-map");
  if (!host) return;
  const portrait = innerWidth < innerHeight;
  const layout = portrait ? "p" : "l";
  if (map.built === layout) return;
  map.built = layout;
  const W = portrait ? 600 : 1600, H = 1000;
  const rnd = seeded(portrait ? 11 : 23);
  const stops = portrait
    ? [[140, 905, "Factory", "Block 1: registered"], [445, 665, "Distributor", "Block 2: seal verified"], [150, 420, "Pharmacy", "Block 3: received cold"], [430, 150, "You", "Block 4: green light"]]
    : [[190, 820, "Factory", "Block 1: registered"], [640, 545, "Distributor", "Block 2: seal verified"], [1070, 720, "Pharmacy", "Block 3: received cold"], [1420, 290, "You", "Block 4: green light"]];
  const river = portrait ? `M-40 560 C 160 520, 260 600, 380 540 S 560 470, 660 520` : `M-60 330 C 260 250, 420 420, 720 360 S 1180 210, 1680 300`;

  let blocks = "";
  const step = portrait ? 60 : 80;
  for (let x = 0; x < W; x += step) for (let y = 0; y < H; y += step) {
    if (rnd() < 0.18) continue;
    const pad = 7 + rnd() * 6;
    blocks += `<rect class="map-block${rnd() > 0.7 ? " alt" : ""}" x="${x + pad}" y="${y + pad}" width="${step - pad * 2}" height="${step - pad * 2}" rx="4"/>`;
  }
  const roads = portrait
    ? ["M0 300 H600", "M0 780 H600", "M300 0 V1000", "M0 120 C 200 160, 400 60, 600 110"]
    : ["M0 640 H1600", "M0 160 C 400 220, 900 80, 1600 150", "M480 0 V1000", "M1240 0 C 1200 400, 1300 700, 1260 1000", "M0 900 C 500 860, 1100 960, 1600 880"];
  const minor = portrait ? ["M120 0 V1000", "M480 0 V1000", "M0 460 H600"] : ["M240 0 V1000", "M800 0 V1000", "M1000 0 V1000", "M0 420 H1600", "M0 760 H1600"];
  const routeD = smoothPath(stops);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="routeGrad" gradientUnits="userSpaceOnUse" x1="${stops[0][0]}" y1="${stops[0][1]}" x2="${stops[3][0]}" y2="${stops[3][1]}">
        <stop offset="0" stop-color="#46cdeb"/><stop offset="1" stop-color="#39e48f"/>
      </linearGradient>
      <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    ${blocks}
    <path class="map-river" d="${river}"/><path class="map-river-glint" d="${river}"/>
    ${minor.map((d) => `<path class="map-road minor" d="${d}"/>`).join("")}
    ${roads.map((d) => `<path class="map-road" d="${d}"/>`).join("")}
    ${roads.map((d, i) => `<path class="map-traffic${i % 2 ? " slow" : ""}" d="${d}" style="animation-delay:-${i * 1.7}s"/>`).join("")}
    <g class="route-layer">
    <path class="route-base" d="${routeD}"/>
    <path class="route-live" id="route-live" d="${routeD}"/>
    <path class="route-pulse" id="route-pulse" d="${routeD}"/>
    ${stops.map(([x, y, name, sub], i) => {
      const right = portrait ? x < 300 : i !== 3;
      const tx = right ? x + 26 : x - 26, anchor = right ? "start" : "end";
      return `<g class="node" data-i="${i}"><circle class="ripple" cx="${x}" cy="${y}" r="14"/><circle class="ring" cx="${x}" cy="${y}" r="14"/><circle class="core" cx="${x}" cy="${y}" r="6"/>
        <text x="${tx}" y="${y - 2}" text-anchor="${anchor}">${name}</text><text class="sub" x="${tx}" y="${y + 16}" text-anchor="${anchor}">${sub}</text></g>`;
    }).join("")}
    <g class="courier" id="courier">
      <circle class="halo" r="24"/>
      <rect class="boxbody" x="-13" y="-10" width="26" height="20" rx="3"/><rect class="boxband" x="-13" y="-10" width="26" height="7" rx="3"/>
      <g transform="translate(20 -36)"><rect class="temp-bg" width="74" height="24" rx="12"/><text class="temp" id="courier-temp" x="37" y="16.5" text-anchor="middle">4.6 °C</text></g>
    </g>
    </g>
  </svg>`;

  map.live = $("#route-live");
  map.len = map.live.getTotalLength();
  map.live.style.strokeDasharray = `${map.len}`;
  const pulse = $("#route-pulse");
  pulse.style.strokeDasharray = `18 ${map.len}`;
  pulse.style.animation = "none";
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches && pulse.animate) {
    pulse.animate([{ strokeDashoffset: map.len + 18 }, { strokeDashoffset: 0 }], { duration: 4200, iterations: Infinity });
  }
  // Where along the route each stop sits.
  map.nodeLen = stops.map(([x, y]) => {
    let best = 0, bestD = Infinity;
    for (let l = 0; l <= map.len; l += 4) {
      const pt = map.live.getPointAtLength(l);
      const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  });
  map.nodes = $$(".node", host);
  map.courier = $("#courier");
  map.temp = $("#courier-temp");
  map.last = -1;
}

function updateMap(p) {
  if (!map.live) return;
  const drawn = Math.max(0.001, Math.min(1, p)) * map.len;
  if (Math.abs(drawn - map.last) < 0.5) return;
  map.last = drawn;
  map.live.style.strokeDashoffset = `${map.len - drawn}`;
  const pt = map.live.getPointAtLength(drawn);
  map.courier.setAttribute("transform", `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
  map.temp.textContent = `${(4.6 + 1.3 * Math.sin(p * 17) + 0.4 * Math.sin(p * 53)).toFixed(1)} °C`;
  map.nodes.forEach((n, i) => n.classList.toggle("lit", drawn >= map.nodeLen[i] - 6));
}

buildMap();
addEventListener("resize", () => { buildMap(); map.last = -1; });

// Cursor spotlight on panels, and a gentle tilt on the "who it helps" cards.
document.addEventListener("pointermove", (ev) => {
  const el = ev.target.closest?.(".card, .stat, .defences li, .aud-grid article");
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${ev.clientX - r.left}px`);
  el.style.setProperty("--my", `${ev.clientY - r.top}px`);
  if (el.matches(".aud-grid article") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.style.setProperty("--ry", `${((ev.clientX - r.left) / r.width - 0.5) * 10}deg`);
    el.style.setProperty("--rx", `${-((ev.clientY - r.top) / r.height - 0.5) * 10}deg`);
  }
}, { passive: true });
$$(".aud-grid article").forEach((a) => a.addEventListener("pointerleave", () => { a.style.setProperty("--rx", "0deg"); a.style.setProperty("--ry", "0deg"); }));

// ------------------------------------------------------------------ motion: scroll story, reveals, counters

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.classList.add("js");

// The green pharmacy cross is a 9 x 9 LED grid. Its LEDs light from the centre outwards
// as you scroll through the story of one box; fully lit = the box earned its green light.
const sign = $("#pharmacy-sign");
const leds = [];
if (sign) {
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    const cell = document.createElement("span");
    const onCross = (r >= 3 && r <= 5) || (c >= 3 && c <= 5);
    cell.className = onCross ? "led on-cross" : "led";
    if (onCross) leds.push({ el: cell, d: Math.hypot(r - 4, c - 4) + ((r * 7 + c * 3) % 5) * 0.01 });
    sign.appendChild(cell);
  }
  leds.sort((a, b) => a.d - b.d).forEach((l, k) => l.el.style.setProperty("--k", k));
}
const steps = $$(".steps li");
const caption = $("#sign-caption");
let lastLit = -1;
let lastStep = -1;

function onScroll() {
  const y = window.scrollY;
  const max = document.documentElement.scrollHeight - innerHeight;
  document.documentElement.style.setProperty("--p", max > 0 ? Math.min(1, y / max) : 0);
  $("#progress-bar").style.setProperty("--p", max > 0 ? Math.min(1, y / max) : 0);
  $(".top").classList.toggle("scrolled", y > 8);
  // The route fades in once the hero is scrolled past, then draws over the rest of the page.
  const start = innerHeight * 0.45;
  document.documentElement.style.setProperty("--route", Math.max(0, Math.min(1, (y - innerHeight * 0.2) / (innerHeight * 0.45))).toFixed(3));
  updateMap(max > start ? (y - start) / (max - start) : 0);
  if (!reduceMotion) $(".hero-art")?.style.setProperty("--sy", Math.min(y, 900));

  const box = $("#journey-scroll");
  if (!box || !sign || box.offsetParent === null) return;
  const rect = box.getBoundingClientRect();
  const vh = innerHeight;
  const p = Math.max(0, Math.min(1, (vh * 0.6 - rect.top) / (rect.height - vh * 0.3)));
  const lit = Math.round(p * leds.length);
  if (lit !== lastLit) {
    leds.forEach((l, i) => l.el.classList.toggle("lit", i < lit));
    sign.style.setProperty("--glow", (lit / leds.length).toFixed(3));
    sign.classList.toggle("full", lit === leds.length);
    lastLit = lit;
  }
  const step = rect.top > vh * 0.75 ? -1 : Math.min(steps.length - 1, Math.floor(p * steps.length * 0.999));
  if (step !== lastStep) {
    steps.forEach((li, i) => { li.classList.toggle("active", i === step); li.classList.toggle("seen", i < step); });
    caption.textContent = lit === leds.length ? "Green light: genuine, cold, sold once"
      : step < 0 ? "Scroll to follow box INS-0001" : `Step ${step + 1} of ${steps.length}: ${steps[step].dataset.step}`;
    lastStep = step;
  }
  if (lit === leds.length && caption.textContent !== "Green light: genuine, cold, sold once") caption.textContent = "Green light: genuine, cold, sold once";
}
let ticking = false;
addEventListener("scroll", () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { onScroll(); ticking = false; });
}, { passive: true });
addEventListener("resize", () => { moveInk(); onScroll(); });

function countUp(el) {
  const target = Number(el.dataset.count);
  const pre = el.dataset.prefix || "", post = el.dataset.suffix || "";
  if (reduceMotion) return;
  const t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / 1300);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = `${pre}${Math.round(target * eased)}${post}`;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const revealer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add("in");
    $$("[data-count]", e.target).forEach(countUp);
    revealer.unobserve(e.target);
  });
}, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }) : null;
$$("[data-reveal]").forEach((el) => (revealer ? revealer.observe(el) : el.classList.add("in")));

const smooth = reduceMotion ? "auto" : "smooth";
$("#to-story")?.addEventListener("click", () => $("#how").scrollIntoView({ behavior: smooth, block: "start" }));
$("#cta-check")?.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: smooth });
  setTimeout(() => $("#check-id").focus({ preventScroll: true }), reduceMotion ? 0 : 500);
});
document.fonts?.ready.then(moveInk);

// ------------------------------------------------------------------ start

function route() {
  const m = location.hash.match(/^#check=(.+)$/);
  const id = m ? decodeURIComponent(m[1]) : params.get("id");
  if (id) { showView("check"); checkBox(id); }
}
window.addEventListener("hashchange", route);

if (!configured) {
  const w = $("#config-warning");
  w.hidden = false;
  w.textContent = "No contract address is set yet. Deploy MediTrail.sol in Remix, then paste the address into web/config.js (or open this page with ?contract=0x…).";
} else {
  $("#contract-link").innerHTML = `Contract ${addrLink(CONFIG.contractAddress)}`;
}
$("#reg-expiry").value = isoDate(new Date(Date.now() + 365 * 864e5));
$("#member-until").value = isoDate(new Date(Date.now() + 365 * 864e5));
renderWallet();
loadDirectory().then(fillSelects).catch(() => {});
route();
moveInk();
onScroll();
