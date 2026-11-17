// Invoice Matching review page. Plain JS, no build step.
// All text from invoices goes through textContent (never innerHTML): invoice data is untrusted.

const $ = (sel) => document.querySelector(sel);
const SVG_NS = "http://www.w3.org/2000/svg";

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const OUTCOME = {
  MATCHED: { label: "Matched", cls: "ok" },
  MATCHED_WITH_NOTE: { label: "Matched, note", cls: "note" },
  REVIEW: { label: "Review", cls: "bad" },
};
const MARK = { pass: "✓", note: "!", fail: "✗", skip: "–" };
const PROVIDER_NAME = { claude: "Claude API", local: "Local LLM" };

const state = {
  invoices: [],
  status: null,
  selectedId: null,
  detail: null,
  detailStamp: null,
  search: "",
  notes: new Map(),
  autoSelected: false,
};

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: fine */
    }
  },
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  return body;
}

const postJson = (path, data) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data ?? {}) });

function showMessage(text, kind = "error") {
  const box = $("#message");
  box.hidden = !text;
  if (!text) return;
  box.textContent = text;
  box.className = `message${kind === "info" ? " info" : ""}`;
}

const chosenProvider = () => $("#provider").value || state.status?.defaultProvider || "claude";

function money(inv, value) {
  return value == null ? "–" : `${inv?.currency ?? ""} ${value}`.trim();
}

// ── status / provider ────────────────────────────────────────────────

async function loadStatus() {
  try {
    state.status = await api("/api/status");
  } catch {
    return;
  }
  const select = $("#provider");
  const previous = select.value || storage.get("provider") || state.status.defaultProvider;
  select.replaceChildren(
    ...state.status.providers.map((p) => h("option", { value: p.provider }, `${PROVIDER_NAME[p.provider]} · ${p.model}`)),
  );
  select.value = state.status.providers.some((p) => p.provider === previous) ? previous : state.status.defaultProvider;
  renderProviderStatus();
}

function renderProviderStatus() {
  const p = state.status?.providers.find((x) => x.provider === chosenProvider());
  if (!p) return;
  $("#provider-dot").className = `dot ${p.ready ? "ok" : "bad"}`;
  const q = state.status.queue?.[p.provider];
  const queue = q && (q.waiting || q.reading) ? ` · queue: ${q.reading} reading (max ${q.limit}), ${q.waiting} waiting` : "";
  $("#provider-hint").textContent = (p.ready ? p.hint : `Not ready · ${p.hint}`) + queue;
}

// ── list ─────────────────────────────────────────────────────────────

function statusOf(inv) {
  if (inv.state === "QUEUED" && inv.attempts > 0) return { label: `Retrying (${inv.attempts + 1})`, cls: "wait" };
  if (inv.state === "QUEUED") return { label: "Waiting", cls: "wait" };
  if (inv.state === "READING") return { label: "Reading…", cls: "wait" };
  return OUTCOME[inv.outcome] ?? OUTCOME.REVIEW;
}

function statusEl(inv) {
  const s = statusOf(inv);
  return h("span", { class: `status ${s.cls}` }, h("span", { class: "status-dot", "aria-hidden": "true" }), s.label);
}

async function loadInvoices() {
  let list;
  try {
    list = await api("/api/invoices");
  } catch (error) {
    showMessage(`Can't reach the server: ${error.message}`);
    return;
  }
  // Only rebuild the list when something changed, so keyboard focus and clicks aren't lost.
  const text = JSON.stringify(list);
  if (text !== state.lastListText) {
    state.lastListText = text;
    state.invoices = list;
    renderSummary();
    renderRows();
  }
  if (!state.selectedId && !state.autoSelected && state.invoices.length) {
    state.autoSelected = true;
    const newest = [...state.invoices].sort((a, b) => b.seq - a.seq)[0];
    await selectInvoice(newest.id, false);
    return;
  }
  const selected = state.invoices.find((i) => i.id === state.selectedId);
  if (state.selectedId && !selected) closeDetail();
  else if (selected && selected.updatedAt !== state.detailStamp) await loadDetail(selected.id);
}

function renderSummary() {
  const count = (fn) => state.invoices.filter(fn).length;
  const done = (o) => count((i) => i.state === "DONE" && i.outcome === o && !(o === "REVIEW" && i.decision));
  const busy = count((i) => i.state !== "DONE");
  const item = (n, label) => h("span", {}, h("b", {}, String(n)), ` ${label}`);
  const decided = count((i) => i.decision);
  const items = [
    item(state.invoices.length, "invoices"),
    item(done("MATCHED"), "matched"),
    item(done("MATCHED_WITH_NOTE"), "with note"),
    item(done("REVIEW"), "to review"),
    busy ? item(busy, "reading") : null,
    decided ? item(decided, "decided") : null,
  ];
  $("#summary").replaceChildren(...items.filter(Boolean));
}

function matchesSearch(inv) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return [inv.supplier, inv.invoiceNumber, inv.poNumber, inv.file].some((v) => v && v.toLowerCase().includes(q));
}

function renderRows() {
  const list = [...state.invoices].sort((a, b) => b.seq - a.seq).filter(matchesSearch);
  const rows = list.map((inv) => {
    const open = () => selectInvoice(inv.id, true);
    return h(
      "div",
      {
        class: `row${inv.id === state.selectedId ? " selected" : ""}`,
        role: "row",
        tabindex: "0",
        "aria-selected": inv.id === state.selectedId ? "true" : "false",
        onclick: open,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        },
      },
      h("span", { class: `cell strong${inv.supplier ? "" : " muted"}`, role: "cell", title: inv.file }, inv.supplier ?? inv.file),
      h("span", { class: "cell", role: "cell" }, inv.invoiceNumber ?? "–"),
      h("span", { class: "cell hide-sm", role: "cell" }, inv.poNumber ?? "–"),
      h("span", { class: "cell num", role: "cell" }, inv.total ?? "–"),
      h(
        "span",
        { class: "cell", role: "cell" },
        statusEl(inv),
        inv.decision ? h("span", { class: "decided" }, inv.decision.status === "APPROVED" ? " · Approved" : " · Rejected") : null,
      ),
    );
  });
  $("#rows").replaceChildren(...rows);
  $("#empty").hidden = state.invoices.length > 0;
}

// ── detail ───────────────────────────────────────────────────────────

async function selectInvoice(id, scroll) {
  state.selectedId = id;
  state.detailStamp = null;
  renderRows();
  await loadDetail(id);
  if (scroll && window.innerWidth <= 1100) $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeDetail() {
  state.selectedId = null;
  state.detail = null;
  state.detailStamp = null;
  $("#detail").hidden = true;
  $("#panel-empty").hidden = false;
  renderRows();
}

async function loadDetail(id) {
  let d;
  try {
    d = await api(`/api/invoices/${encodeURIComponent(id)}`);
  } catch (error) {
    showMessage(error.message);
    return;
  }
  if (id !== state.selectedId) return;
  state.detail = d;
  state.detailStamp = d.updatedAt;
  renderDetail(d);
}

function ringStat(done, total, label) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const share = total > 0 ? done / total : 0;
  const ring = svg("svg", { class: "ring", viewBox: "0 0 40 40", "aria-hidden": "true" });
  ring.append(
    svg("circle", { class: "track", cx: 20, cy: 20, r }),
    svg("circle", { class: "value", cx: 20, cy: 20, r, "stroke-dasharray": `${share * c} ${c}` }),
  );
  return h("div", { class: "ring-stat" }, ring, h("div", {}, h("b", {}, total ? `${done} of ${total}` : "–"), h("span", {}, label)));
}

function summaryBlock(d) {
  const checks = (d.result?.checks ?? []).filter((c) => c.status !== "skip");
  const passed = checks.filter((c) => c.status !== "fail").length;
  const lines = d.result?.context?.lines ?? [];
  const goodLines = lines.filter((l) => l.po && l.priceStatus !== "fail" && l.qtyStatus === "pass").length;
  return h(
    "section",
    { class: "block" },
    h("p", { class: "label" }, "Match summary"),
    h("div", { class: "rings" }, ringStat(passed, checks.length, "Checks passed"), ringStat(goodLines, lines.length, "Lines match PO")),
  );
}

function linesBlock(d) {
  const ctx = d.result?.context;
  if (!ctx?.po || !ctx.lines.length) return null;
  const items = ctx.lines.map((l) => {
    if (!l.po) {
      return h(
        "div",
        { class: "bar-item" },
        h("div", { class: "bar-head" }, h("span", {}, l.description), h("b", {}, l.quantity)),
        h("div", { class: "bar over" }, h("i", { style: "width:100%" })),
        h("div", { class: "bar-note bad" }, "Not on the PO"),
      );
    }
    const invoiced = Number(l.quantity);
    const received = Number(l.po.receivedQty);
    const share = received > 0 ? Math.min(1, invoiced / received) : 1;
    const over = l.qtyStatus === "fail";
    const notes = [];
    if (over) notes.push(h("div", { class: "bar-note bad" }, `Invoiced ${l.quantity}, only ${l.po.receivedQty} received`));
    if (l.priceStatus !== "pass") {
      notes.push(
        h(
          "div",
          { class: `bar-note ${l.priceStatus === "fail" ? "bad" : "note"}` },
          `Price ${l.invoicePriceExTax}, PO says ${l.po.unitPrice} (${l.priceEffect} on ${l.quantity})`,
        ),
      );
    }
    return h(
      "div",
      { class: "bar-item" },
      h("div", { class: "bar-head" }, h("span", { title: `PO: ${l.po.description}` }, l.description), h("b", {}, `${l.quantity} / ${l.po.receivedQty}`)),
      h("div", { class: `bar${over ? " over" : ""}`, role: "img", "aria-label": `${l.quantity} invoiced of ${l.po.receivedQty} received` }, h("i", { style: `width:${Math.round(share * 100)}%` })),
      notes,
    );
  });
  return h("section", { class: "block" }, h("p", { class: "label" }, `Invoiced vs received · ${ctx.po.poNumber}`), items);
}

function checksBlock(d) {
  if (d.state !== "DONE") {
    const waitText = d.state === "READING" ? "Reading the invoice…" : d.retryError ? `Will try again: ${d.retryError}` : "Waiting in the queue…";
    return h("section", { class: "block" }, h("p", { class: "label" }, "Checks"), h("p", { class: "muted" }, waitText));
  }
  const items = (d.result?.checks ?? []).map((c) =>
    h(
      "li",
      {},
      h("span", { class: `mark ${c.status}`, "aria-label": c.status }, MARK[c.status]),
      h(
        "div",
        {},
        h("span", {}, c.name),
        c.details.length
          ? c.details.map((t) => h("span", { class: `check-detail ${c.status}` }, t))
          : h("span", { class: "check-detail" }, c.status === "pass" ? "OK" : ""),
      ),
    ),
  );
  return h(
    "section",
    { class: "block" },
    h("p", { class: "label" }, "Checks"),
    d.error ? h("div", { class: "error-box" }, `Could not read the file: ${d.error}`) : null,
    items.length ? h("ul", { class: "checks" }, items) : null,
  );
}

function fieldsBlock(d) {
  const inv = d.result?.invoice;
  if (!inv) return null;
  const s = d.result.context?.supplier;
  const digits = (x) => String(x ?? "").replace(/\D/g, "");
  const ident = (x) => String(x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const field = (label, value, extra) => [h("dt", {}, label), h("dd", {}, value ?? "–", extra ?? null)];
  const compared = (label, value, onFile, same) => {
    const differs = value && onFile != null && !same(value, onFile);
    return field(
      label,
      h("span", { class: differs ? "differs" : "" }, value ?? "–"),
      onFile != null ? h("span", { class: "muted" }, ` · on file ${onFile}`) : null,
    );
  };
  return h(
    "section",
    { class: "block" },
    h("p", { class: "label" }, "What was read"),
    h(
      "dl",
      { class: "fields" },
      field("Supplier", inv.supplier.name, h("span", { class: "muted" }, s ? " · on our list" : " · not on our list")),
      compared("UEN", inv.supplier.uen, s?.uen ?? null, (a, b) => ident(a) === ident(b)),
      compared("GST reg. no.", inv.supplier.gstRegNo, s ? (s.gstRegNo ?? "not GST-registered") : null, (a, b) => ident(a) === ident(b)),
      compared("Bank account", inv.bank.accountNumber, s?.bankAccountNumber ?? null, (a, b) => digits(a) === digits(b)),
      field("PO", inv.poNumber),
      field("Invoice date", inv.invoiceDate, inv.dueDate ? h("span", { class: "muted" }, ` · due ${inv.dueDate}`) : null),
      field(
        "Total",
        money(inv, inv.total),
        h("span", { class: "muted" }, ` · subtotal ${inv.subtotal} + GST ${inv.tax}${inv.pricesIncludeTax ? " (included)" : ""}`),
      ),
      field("Read by", readByText(d), d.seconds != null ? h("span", { class: "muted" }, ` · ${d.seconds}s`) : null),
    ),
  );
}

function readByText(d) {
  if (d.state !== "DONE") return PROVIDER_NAME[d.provider];
  if (d.readBy === "xml") return "InvoiceNow XML (no AI)";
  if (!d.readBy) return `${PROVIDER_NAME[d.provider]} (failed)`;
  return `${PROVIDER_NAME[d.readBy]}${d.model ? ` · ${d.model}` : ""}`;
}

function decisionBlock(d) {
  const note = h("input", {
    type: "text",
    placeholder: "Note, e.g. confirmed new bank account by phone",
    "aria-label": "Decision note",
    value: state.notes.get(d.id) ?? d.decision?.note ?? "",
    oninput: (e) => state.notes.set(d.id, e.target.value),
  });
  const decide = async (decision) => {
    if (decision === "APPROVED" && d.outcome === "REVIEW" && !confirm("This invoice failed checks. Approve it anyway?")) return;
    try {
      await postJson(`/api/invoices/${encodeURIComponent(d.id)}/decision`, { decision, note: note.value });
      state.notes.delete(d.id);
      await loadInvoices();
    } catch (error) {
      showMessage(error.message);
    }
  };
  const done = d.state === "DONE";
  return h(
    "section",
    { class: "block" },
    h("p", { class: "label" }, "Decision"),
    d.decision
      ? h("p", { class: "muted small" }, `${d.decision.status === "APPROVED" ? "Approved" : "Rejected"} ${new Date(d.decision.at).toLocaleString()}${d.decision.note ? ` · ${d.decision.note}` : ""}`)
      : null,
    h(
      "div",
      { class: "actions" },
      note,
      h(
        "div",
        { class: "btn-row" },
        h("button", { type: "button", class: "btn primary", onclick: () => decide("APPROVED"), disabled: !done }, "Approve"),
        h("button", { type: "button", class: "btn", onclick: () => decide("REJECTED"), disabled: !done }, "Reject"),
      ),
    ),
  );
}

function rereadBlock(d) {
  if (d.readBy === "xml") return null;
  const select = h(
    "select",
    { "aria-label": "Read again with" },
    (state.status?.providers ?? []).map((p) => h("option", { value: p.provider }, `${PROVIDER_NAME[p.provider]} · ${p.model}`)),
  );
  select.value = chosenProvider();
  const reread = async () => {
    try {
      await postJson(`/api/invoices/${encodeURIComponent(d.id)}/reread`, { provider: select.value });
      await loadInvoices();
    } catch (error) {
      showMessage(error.message);
    }
  };
  return h(
    "section",
    { class: "block" },
    h("p", { class: "label" }, "Read again · compare the two AIs"),
    h("div", { class: "reread" }, select, h("button", { type: "button", class: "btn", onclick: reread, disabled: d.state !== "DONE" }, "Read again")),
  );
}

function iconButton(title, path, onclick) {
  const icon = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  for (const p of path) icon.append(svg("path", { d: p }));
  return h("button", { type: "button", class: "icon-btn", title, onclick }, icon, h("span", { class: "sr-only" }, title));
}

function renderDetail(d) {
  const inv = d.result?.invoice;
  const status = statusOf(d);
  const sections = [
    h(
      "div",
      { class: "panel-top" },
      iconButton("View original file", ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"], () => openViewer(d)),
      iconButton("Close", ["M6 6l12 12", "M18 6 6 18"], closeDetail),
    ),
    h("h2", {}, inv?.supplier.name ?? d.file),
    h("p", { class: "subtitle" }, [inv?.invoiceNumber, d.file].filter(Boolean).join(" · ")),
    h(
      "div",
      { class: "result-line" },
      h("span", { class: `tag ${status.cls}` }, status.label),
      d.decision ? h("span", { class: `tag ${d.decision.status === "APPROVED" ? "ok" : "bad"}` }, d.decision.status === "APPROVED" ? "Approved" : "Rejected") : null,
      inv ? h("span", { class: "muted" }, money(inv, inv.total)) : null,
    ),
    d.state === "DONE" && d.result?.checks?.length ? summaryBlock(d) : null,
    linesBlock(d),
    checksBlock(d),
    fieldsBlock(d),
    d.state === "DONE" ? decisionBlock(d) : null,
    rereadBlock(d),
  ];
  $("#detail").replaceChildren(...sections.filter(Boolean));
  $("#detail").hidden = false;
  $("#panel-empty").hidden = true;
}

// ── original file viewer ─────────────────────────────────────────────

let viewerReturnFocus = null;

function openViewer(d) {
  const fileUrl = `/api/invoices/${encodeURIComponent(d.id)}/file`;
  let body;
  if (d.previewKind === "image") body = h("img", { src: `/api/invoices/${encodeURIComponent(d.id)}/preview?v=${d.updatedAt}`, alt: `Invoice ${d.file}` });
  else if (d.previewKind === "pages") {
    // PDF pages rendered as images by the server: works in every browser.
    const pages = Array.from({ length: Math.max(1, d.pages) }, (_, i) =>
      h("img", { src: `/api/invoices/${encodeURIComponent(d.id)}/preview?page=${i + 1}`, alt: `${d.file}, page ${i + 1}`, loading: "lazy" }),
    );
    body = h("div", { class: "pages" }, pages);
  }
  else if (d.previewKind === "text") body = h("pre", {}, d.previewText ?? "");
  else body = h("p", { class: "panel-empty" }, "No preview for this file type.");
  $("#viewer-title").textContent = d.file;
  $("#viewer-open").href = fileUrl;
  $("#viewer-body").replaceChildren(body);
  viewerReturnFocus = document.activeElement;
  $("#viewer").hidden = false;
  $("#viewer-close").focus();
}

function closeViewer() {
  $("#viewer").hidden = true;
  $("#viewer-body").replaceChildren();
  viewerReturnFocus?.focus?.();
}

$("#viewer-close").addEventListener("click", closeViewer);
$("#viewer").addEventListener("click", (e) => {
  if (e.target === $("#viewer")) closeViewer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#viewer").hidden) closeViewer();
});

// ── actions ──────────────────────────────────────────────────────────

async function withBusy(button, work) {
  button.disabled = true;
  showMessage(null);
  try {
    await work();
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

function reportAdded(result) {
  if (result.skipped?.length) showMessage(`Skipped: ${result.skipped.join("; ")}`);
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

async function uploadFiles(fileList) {
  const all = [...fileList];
  const tooBig = all.filter((f) => f.size > MAX_FILE_BYTES);
  const files = all.filter((f) => f.size <= MAX_FILE_BYTES);
  if (tooBig.length) showMessage(`Skipped (larger than 25 MB): ${tooBig.map((f) => f.name).join(", ")}`);
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append("files", f, f.name);
  form.append("provider", chosenProvider());
  showMessage(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`, "info");
  try {
    const result = await api("/api/invoices", { method: "POST", body: form });
    showMessage(tooBig.length ? `Skipped (larger than 25 MB): ${tooBig.map((f) => f.name).join(", ")}` : null);
    reportAdded(result);
    if (result.added?.[0]) state.selectedId = null;
    state.autoSelected = false;
    await loadInvoices();
  } catch (error) {
    showMessage(error.message);
  }
}

$("#upload").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", (e) => {
  uploadFiles(e.target.files);
  e.target.value = "";
});

// Drop files anywhere on the list.
const main = $("#main");
let dragDepth = 0;
main.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  $("#drop-overlay").hidden = false;
});
main.addEventListener("dragover", (e) => e.preventDefault());
main.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("#drop-overlay").hidden = true;
});
main.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  uploadFiles(e.dataTransfer.files);
});

$("#search-toggle").addEventListener("click", () => {
  const box = $("#search-box");
  box.hidden = !box.hidden;
  if (!box.hidden) $("#search").focus();
  else {
    $("#search").value = "";
    state.search = "";
    renderRows();
  }
});
$("#search").addEventListener("input", (e) => {
  state.search = e.target.value.trim();
  renderRows();
});

$("#run-samples").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    reportAdded(await postJson("/api/samples", { provider: chosenProvider() }));
    state.autoSelected = false;
    state.selectedId = null;
    await loadInvoices();
  }),
);

$("#recheck").addEventListener("click", (e) =>
  withBusy(e.currentTarget, async () => {
    await postJson("/api/recheck");
    state.detailStamp = null;
    await loadInvoices();
    showMessage("Suppliers and POs reloaded from data/, all checks run again.", "info");
  }),
);

$("#clear").addEventListener("click", (e) => {
  if (!confirm("Remove all invoices from this list? The uploaded copies are deleted too.")) return;
  withBusy(e.currentTarget, async () => {
    await api("/api/invoices", { method: "DELETE" });
    closeDetail();
    await loadInvoices();
  });
});

$("#provider").addEventListener("change", () => {
  storage.set("provider", $("#provider").value);
  renderProviderStatus();
});

// ── start ────────────────────────────────────────────────────────────

const now = new Date();
$("#eyebrow").textContent = `${now.toLocaleString("en", { month: "short" }).toUpperCase()}'${String(now.getFullYear()).slice(2)}`;

await loadStatus();
await loadInvoices();
setInterval(() => {
  if (document.visibilityState === "visible" || state.invoices.some((i) => i.state !== "DONE")) loadInvoices();
}, 2000);
setInterval(() => {
  if (state.invoices.some((i) => i.state !== "DONE")) loadStatus();
}, 4000);
setInterval(loadStatus, 15000);
