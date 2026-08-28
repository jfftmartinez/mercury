(() => {
  "use strict";
  let stopRequested = false;
  const WAIT = 750,
    clean = (v) =>
      String(v ?? "")
        .trim()
        .replace(/\s+/g, " "),
    sleep = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        checkStopped();
        await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
      }
      checkStopped();
    };
  const runWarnings = [];
  function checkStopped() {
    if (!stopRequested) return;
    const error = new Error("Automation stopped by user.");
    error.name = "StopError";
    throw error;
  }
  const visible = (e) => {
    if (!e) return false;
    const s = getComputedStyle(e),
      r = e.getBoundingClientRect();
    return (
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      r.width > 0 &&
      r.height > 0
    );
  };
  function key(e, k, c, n) {
    ["keydown", "keypress", "keyup"].forEach((t) =>
      e.dispatchEvent(
        new KeyboardEvent(t, {
          key: k,
          code: c,
          keyCode: n,
          which: n,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }
  const enter = (e) => key(e, "Enter", "Enter", 13),
    esc = (e) =>
      key(e || document.activeElement || document.body, "Escape", "Escape", 27),
    f4 = (e) => key(e, "F4", "F4", 115);
  async function typeKeys(el, text) {
    for (const ch of String(text)) {
      const code = ch.toUpperCase().charCodeAt(0);
      key(el, ch, `Key${ch.toUpperCase()}`, code);
      await sleep(25);
    }
  }
  function click(e) {
    if (!e) throw Error("Required Mercury control not found.");
    e.scrollIntoView({ block: "center", inline: "center" });
    e.focus?.();
    ["mousedown", "mouseup", "click"].forEach((t) =>
      e.dispatchEvent(
        new MouseEvent(t, {
          view: window,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: t === "mousedown" ? 1 : 0,
        }),
      ),
    );
  }
  function setVal(e, v) {
    const x = String(v ?? ""),
      set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
    if (set && e instanceof HTMLInputElement) set.call(e, x);
    else e.value = x;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function submit(e, v) {
    click(e);
    setVal(e, v);
    enter(e);
  }
  function waitFor(fn, label, ms = 5000) {
    return new Promise((res, rej) => {
      const st = Date.now(),
        id = setInterval(() => {
          let x;
          try {
            checkStopped();
            x = fn();
          } catch (_) {}
          if (x) {
            clearInterval(id);
            res(x);
          } else if (Date.now() - st >= ms) {
            clearInterval(id);
            rej(Error(`Timeout waiting for ${label}.`));
          }
        }, 40);
    });
  }
  function add(id, n) {
    const m = /^(WD)([0-9A-F]+)$/i.exec(id || "");
    if (!m) throw Error(`Unexpected control ID ${id}`);
    return (
      m[1] +
      (parseInt(m[2], 16) + n)
        .toString(16)
        .toUpperCase()
        .padStart(m[2].length, "0")
    );
  }
  function anchors() {
    return [...document.querySelectorAll('input[ct="CBS"][maxlength="40"]')]
      .filter((e) => visible(e) && !e.readOnly && e.tabIndex >= 0)
      .sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      );
  }
  function sameRow(e, a) {
    const x = e.getBoundingClientRect(),
      y = a.getBoundingClientRect();
    return (
      visible(e) && Math.abs(x.top + x.height / 2 - (y.top + y.height / 2)) <= 6
    );
  }
  function controls(base, row) {
    const a = document.getElementById(base);
    if (!a) throw Error(`Row ${row + 1} anchor ${base} missing.`);
    const activity = document.getElementById(add(base, 4)),
      attendance = document.getElementById(add(base, 11));
    const h = [...document.querySelectorAll('input[ct="CBS"][maxlength="20"]')]
      .filter((e) => sameRow(e, a))
      .sort(
        (x, y) =>
          x.getBoundingClientRect().left - y.getBoundingClientRect().left,
      )
      .slice(-7);
    if (!activity) throw Error(`Row ${row + 1} Activity missing.`);
    if (!attendance) throw Error(`Row ${row + 1} Attendance missing.`);
    if (h.length !== 7)
      throw Error(`Row ${row + 1} has ${h.length} hour fields.`);
    return {
      anchor: a,
      activity,
      attendance,
      hours: h,
      sa: h[0],
      su: h[1],
      mo: h[2],
      tu: h[3],
      we: h[4],
      th: h[5],
      fr: h[6],
    };
  }
  async function live(base, row, label) {
    return waitFor(
      () => {
        try {
          return controls(base, row);
        } catch (_) {
          return null;
        }
      },
      `Row ${row + 1} ${label}`,
    );
  }
  function option(txt, field) {
    const v = clean(txt).toLowerCase();
    return [
      ...document.querySelectorAll(
        "[role='option'],[role='menuitem'],li,td,span,div,a",
      ),
    ]
      .filter(
        (e) =>
          e !== field &&
          visible(e) &&
          e.getAttribute("ct") !== "CB" &&
          clean(e.textContent).toLowerCase() === v,
      )
      .sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height,
      )[0];
  }
  async function attendance(data, row, base) {
    let c = await live(base, row, "Attendance");
    const expected = add(base, 11);
    if (c.attendance.id !== expected)
      throw Error(
        `Row ${row + 1} wrong Attendance ${c.attendance.id}; expected ${expected}.`,
      );

    // Requested keyboard workflow:
    // Activity ID -> Tab equivalent -> Attendance -> F4 -> type value -> Enter
    // -> Tab equivalent -> Monday.
    // Direct focus is used for the two Tab steps because synthetic Tab events
    // do not reliably move focus in Chromium content scripts.
    c.attendance.focus();
    f4(c.attendance);
    await sleep(300);

    const typingTarget = document.activeElement || c.attendance;
    await typeKeys(typingTarget, data.att);
    await sleep(200);
    enter(document.activeElement || typingTarget);
    await sleep(500);

    c = await live(base, row, "Monday after Attendance keyboard selection");
    c.mo.focus();
    await sleep(180);
    // Intentionally no Attendance retention validation.
  }
  function focusables(scope = document) {
    return [
      ...scope.querySelectorAll(
        'input:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],[tabindex="0"],[ct="B"]',
      ),
    ].filter(visible);
  }
  function next(e, scope = document) {
    const a = focusables(scope),
      n = a[a.indexOf(e) + 1];
    n?.focus?.();
    return n;
  }
  function popup() {
    return [
      ...document.querySelectorAll(
        '[role="dialog"],.urPW,.lsPopupWindow,[ct="PW"],div,table',
      ),
    ]
      .filter(visible)
      .filter((e) => clean(e.textContent).toLowerCase().includes("details"))
      .sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height,
      )[0];
  }
  async function details(hour, text, label) {
    if (!clean(text)) return true;

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Reproduce the proven flow exactly:
        // hour -> Tab-equivalent details icon -> Enter -> popup -> Note -> Tab-equivalent OK -> Enter.
        hour.focus();
        const trigger = next(hour);
        if (!trigger) throw Error(`${label} details trigger missing.`);
        enter(trigger);
        await sleep(300);

        const p = await waitFor(popup, `${label} popup`, 5000);
        const ed = await waitFor(
          () => {
            const a = document.activeElement;
            if (
              a &&
              visible(a) &&
              !a.readOnly &&
              (a instanceof HTMLInputElement ||
                a instanceof HTMLTextAreaElement)
            )
              return a;
            return [...p.querySelectorAll("textarea,input[type='text']")]
              .filter(visible)
              .find((e) => !e.readOnly);
          },
          `${label} note`,
          5000,
        );

        ed.focus();
        setVal(ed, text);
        await sleep(120);

        let ok =
          next(ed) ||
          focusables(p).find(
            (e) =>
              clean(
                e.innerText || e.textContent || e.value || e.title,
              ).toLowerCase() === "ok",
          );
        if (!ok) throw Error(`${label} OK missing.`);
        enter(ok);
        await sleep(500);
        await waitFor(() => !visible(p), `${label} popup close`, 5000);
        return true;
      } catch (error) {
        lastError = error;
        if (attempt === 1) {
          // Dismiss any partial popup/focus state, reacquire the live hour field
          // in the caller, and try the same sequence once more.
          esc(document.activeElement || document.body);
          await sleep(250);
          continue;
        }
      }
    }

    runWarnings.push(
      `${label}: ${lastError?.message || "Details popup failed"}`,
    );
    return false;
  }

  async function restore(data, row, base) {
    let c = await live(base, row, "Activity");
    if (clean(c.activity.value) !== clean(data.activity)) {
      submit(c.activity, data.activity);
      await sleep(WAIT);
    }
  }
  async function findNextEmptyEngagementRow() {
    return waitFor(
      () => {
        const rows = anchors();
        const rowIndex = rows.findIndex((anchor) => clean(anchor.value) === "");

        if (rowIndex === -1) return null;

        const anchor = rows[rowIndex];
        return anchor.isConnected &&
          visible(anchor) &&
          !anchor.disabled &&
          !anchor.readOnly
          ? { rowIndex, anchorId: anchor.id }
          : null;
      },
      "next empty Engagement ID row",
      7000,
    );
  }

  async function process(data, row) {
    const a = anchors()[row];
    if (!a) throw Error(`Mercury row ${row + 1} missing.`);
    if (clean(a.value) !== "")
      throw Error(`Mercury row ${row + 1} is no longer empty.`);
    const base = a.id;
    submit(a, data.engagement);
    await sleep(WAIT);
    let c = await live(base, row, "Activity");
    submit(c.activity, data.activity);
    await sleep(WAIT);
    await attendance(data, row, base);
    await restore(data, row, base);
    const ds = [
      ["Saturday", "sa", data.sa, data.saD],
      ["Sunday", "su", data.su, data.suD],
      ["Monday", "mo", data.mo, data.moD],
      ["Tuesday", "tu", data.tu, data.tuD],
      ["Wednesday", "we", data.we, data.weD],
      ["Thursday", "th", data.th, data.thD],
      ["Friday", "fr", data.fr, data.frD],
    ];
    for (const [label, k, h, d] of ds) {
      if (!clean(h)) continue;
      c = await live(base, row, label);
      let f = c[k];
      click(f);
      setVal(f, h);
      enter(f);
      await sleep(WAIT);
      c = await live(base, row, `${label} live`);
      f = c[k];
      const v = clean(f.value),
        x = Number(h).toFixed(2);
      if (v !== clean(h) && v !== x)
        throw Error(`Row ${row + 1} ${label} hours not committed.`);
      await restore(data, row, base);
      c = await live(base, row, `${label} details`);
      await details(c[k], d, `Row ${row + 1} ${label}`);
      await restore(data, row, base);
    }
  }
  function frame() {
    try {
      return window.frameElement?.id || window.name || "";
    } catch (_) {
      return window.name || "";
    }
  }
  function probe() {
    const a = anchors(),
      id = frame();
    return {
      valid: a.length > 0 && !!document.getElementById(add(a[0]?.id, 11)),
      score: a.length + (id ? 2 : 0),
      frameElementId: id,
    };
  }
  chrome.runtime.onMessage.addListener((m, s, r) => {
    if (m?.type === "STOP") {
      stopRequested = true;
      esc(document.activeElement || document.body);
      r({ ok: true });
      return;
    }
    if (m?.type === "PROBE") {
      r(probe());
      return;
    }
    if (m?.type !== "EXEC") return;
    (async () => {
      let done = 0;
      stopRequested = false;
      runWarnings.length = 0;
      try {
        for (let i = 0; i < m.rows.length; i++) {
          checkStopped();
          // Records 1-5 do not scroll. Starting with record 6, click once,
          // wait 500 ms, and only then find the next blank Engagement ID.
          if (i >= 5) {
            const scrollDown = document.getElementById("WD023A-scrollV-Nxt");
            if (!scrollDown)
              throw Error("Mercury vertical scroll-down button not found.");
            click(scrollDown);
            await sleep(500);
          }
          // Re-scan before every record because Mercury can rerender or activate
          // new rows after the previous record is committed.
          const destination = await findNextEmptyEngagementRow();
          await process(m.rows[i], destination.rowIndex);
          done++;
        }
        r({ ok: true, completed: done, warnings: [...runWarnings] });
      } catch (e) {
        r({
          ok: false,
          completed: done,
          error: e.name === "StopError" ? e.message : `Excel row ${m.rows[done]?.sourceRow || "unknown"}: ${e.message}`,
          warnings: [...runWarnings],
        });
      }
    })();
    return true;
  });
  function val(r, ...ns) {
    const k = Object.keys(r).find((k) =>
      ns.some((n) => clean(k).toLowerCase() === n.toLowerCase()),
    );
    return k ? r[k] : "";
  }
  function norm(r, i) {
    return {
      sourceRow: i + 7,
      engagement: clean(val(r, "Engagement ID")),
      activity: clean(val(r, "Activity ID")),
      att: clean(val(r, "Att./Abs. Type.")),
      sa: clean(val(r, "SA XX")),
      saD: clean(val(r, "Details")),
      su: clean(val(r, "Su XX")),
      suD: clean(val(r, "Details_1")),
      mo: clean(val(r, "Mo XX")),
      moD: clean(val(r, "Details_2")),
      tu: clean(val(r, "Tu XX")),
      tuD: clean(val(r, "Details_3")),
      we: clean(val(r, "We XX")),
      weD: clean(val(r, "Details_4")),
      th: clean(val(r, "Th XX")),
      thD: clean(val(r, "Details_5")),
      fr: clean(val(r, "Fr XX")),
      frD: clean(val(r, "Details_6")),
    };
  }
  function overlay() {
    if (top !== window || document.getElementById("x2m-launcher")) return;
    const s = document.createElement("style");
    s.textContent =
      "#x2m-launcher{position:fixed;right:22px;bottom:22px;width:58px;height:58px;border:0;border-radius:50%;z-index:2147483647;background:#107c41;box-shadow:0 8px 24px #0005;cursor:pointer;color:#fff;font:bold 24px Segoe UI}#x2m-panel{position:fixed;right:22px;bottom:92px;width:330px;z-index:2147483647;background:#fff;border-radius:15px;box-shadow:0 15px 40px #0005;padding:16px;font:13px Segoe UI;display:none}#x2m-panel.open{display:block}#x2m-panel input,#x2m-panel button{width:100%;box-sizing:border-box;margin-top:9px}#x2m-panel button{padding:10px;border:0;border-radius:7px;background:#107c41;color:#fff;font-weight:700}#x2m-stop{background:#c42b1c}#x2m-panel button:disabled{opacity:.55;cursor:not-allowed}#x2m-status{white-space:pre-wrap;margin-top:10px;background:#f3f3f3;padding:9px;border-radius:7px}";
    document.documentElement.appendChild(s);
    const l = document.createElement("button");
    l.id = "x2m-launcher";
    l.textContent = "X";
    l.title = "Mercury Automation";
    const p = document.createElement("section");
    p.id = "x2m-panel";
    p.innerHTML =
      '<h2>Mercury Automation</h2><div>Select template file for import.</div><input id="x2m-file" type="file" accept=".xlsm,.xlsx,.xls"><button id="x2m-run">Run automation</button><button id="x2m-stop" disabled>Stop automation</button><div id="x2m-status">Ready.</div>';
    document.documentElement.append(p, l);
    l.onclick = () => p.classList.toggle("open");
    const f = p.querySelector("#x2m-file"),
      b = p.querySelector("#x2m-run"),
      stop = p.querySelector("#x2m-stop"),
      st = p.querySelector("#x2m-status");
    stop.onclick = async () => {
      stop.disabled = true;
      st.textContent = "Stopping automation...";
      const out = await chrome.runtime.sendMessage({ type: "STOP" });
      if (!out?.ok) st.textContent = `Unable to stop: ${out?.error || "Unknown error"}`;
    };
    b.onclick = async () => {
      if (!f.files[0])
        return (st.textContent = "Select an XLSM, XLSX, or XLS file first.");
      b.disabled = true;
      stop.disabled = false;
      try {
        const w = XLSX.read(await f.files[0].arrayBuffer(), { type: "array" }),
          sh = w.Sheets["Mercury Upload"];
        if (!sh) throw Error('Worksheet "Mercury Upload" was not found.');
        const rs = XLSX.utils
          .sheet_to_json(sh, { range: 5, defval: "", raw: false })
          .map(norm)
          .filter((x) => x.engagement || x.activity);
        if (!rs.length)
          throw Error('No data found in "Mercury Upload" starting at row 7.');
        st.textContent = `Appending ${rs.length} row(s) at the next empty Engagement ID row...`;
        const out = await chrome.runtime.sendMessage({ type: "RUN", rows: rs });
        if (!out?.ok) throw Error(out?.error || "Stopped");
        const warnings = out.warnings || [];
        st.textContent = `Completed ${out.completed}/${rs.length}\nFrame: ${out.frameLabel}${warnings.length ? `\nWarnings (${warnings.length}):\n${warnings.map((x) => `• ${x}`).join("\n")}` : ""}`;
      } catch (e) {
        st.textContent = `Stopped: ${e.message}`;
      } finally {
        b.disabled = false;
        stop.disabled = true;
      }
    };
  }
  overlay();
})();
