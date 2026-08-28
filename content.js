(() => {
  "use strict";

  let stopRequested = false;
  const VERSION = "2026-08-28.6";
  const SETTLE = 120;
  const INPUT_EVENT_PAUSE = 75;
  const POST_ENTER_PAUSE = 320;
  const COMMIT_TIMEOUT = 3500;
  const ATTENDANCE_TIMEOUT = 1800;
  const ATTEMPTS = 3;
  const runWarnings = [];
  const confirmedAttendance = new Map();

  const clean = (v) =>
    String(v ?? "")
      .replace(/\u00a0/g, " ")
      .trim()
      .replace(/\s+/g, " ");

  const comparable = (v) => clean(v).toLowerCase();

  function checkStopped() {
    if (!stopRequested) return;
    const error = new Error("Automation stopped by user.");
    error.name = "StopError";
    throw error;
  }

  async function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      checkStopped();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, end - Date.now())),
      );
    }
    checkStopped();
  }

  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  function key(element, keyName, code, number) {
    ["keydown", "keypress", "keyup"].forEach((type) =>
      element.dispatchEvent(
        new KeyboardEvent(type, {
          key: keyName,
          code,
          keyCode: number,
          which: number,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }

  const enter = (element) => key(element, "Enter", "Enter", 13);
  const esc = (element) =>
    key(
      element || document.activeElement || document.body,
      "Escape",
      "Escape",
      27,
    );
  const f4 = (element) => key(element, "F4", "F4", 115);

  async function typeKeys(element, text) {
    for (const character of String(text)) {
      let code;
      let number;

      if (/^[a-z]$/i.test(character)) {
        code = `Key${character.toUpperCase()}`;
        number = character.toUpperCase().charCodeAt(0);
      } else if (/^[0-9]$/.test(character)) {
        code = `Digit${character}`;
        number = character.charCodeAt(0);
      } else if (character === " ") {
        code = "Space";
        number = 32;
      } else {
        code = character;
        number = character.charCodeAt(0);
      }

      key(element, character, code, number);
      await sleep(18);
    }
  }

  function click(element) {
    if (!element) throw Error("Required Mercury control not found.");
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus?.();
    ["mousedown", "mouseup", "click"].forEach((type) =>
      element.dispatchEvent(
        new MouseEvent(type, {
          view: window,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "mousedown" ? 1 : 0,
        }),
      ),
    );
  }

  function setVal(element, value) {
    const text = String(value ?? "");
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (setter) setter.call(element, text);
    else element.value = text;

    try {
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text,
        }),
      );
    } catch (_) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function pressEnterAndSettle(element) {
    await sleep(INPUT_EVENT_PAUSE);
    const replacement = element?.id
      ? document.getElementById(element.id)
      : null;
    const target =
      replacement ||
      (element?.isConnected && element) ||
      document.activeElement ||
      document.body;
    target.focus?.();
    enter(target);
    await sleep(POST_ENTER_PAUSE);
  }

  async function submit(element, value) {
    click(element);
    element.select?.();
    setVal(element, value);
    await pressEnterAndSettle(element);
  }

  function waitFor(fn, label, ms = 5000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const id = setInterval(() => {
        let result;
        try {
          checkStopped();
          result = fn();
        } catch (error) {
          if (error?.name === "StopError") {
            clearInterval(id);
            reject(error);
            return;
          }
        }

        if (result) {
          clearInterval(id);
          resolve(result);
        } else if (Date.now() - started >= ms) {
          clearInterval(id);
          reject(Error(`Timeout waiting for ${label}.`));
        }
      }, 50);
    });
  }

  function add(id, amount) {
    const match = /^(WD)([0-9A-F]+)$/i.exec(id || "");
    if (!match) throw Error(`Unexpected control ID ${id}`);
    return (
      match[1] +
      (parseInt(match[2], 16) + amount)
        .toString(16)
        .toUpperCase()
        .padStart(match[2].length, "0")
    );
  }

  function anchors() {
    return [...document.querySelectorAll('input[ct="CBS"][maxlength="40"]')]
      .filter(
        (element) =>
          visible(element) && !element.readOnly && element.tabIndex >= 0,
      )
      .sort(
        (a, b) =>
          a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      );
  }

  function sameRow(element, anchor) {
    const elementRect = element.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    return (
      visible(element) &&
      Math.abs(
        elementRect.top + elementRect.height / 2 -
          (anchorRect.top + anchorRect.height / 2),
      ) <= 6
    );
  }

  function controls(base, row) {
    const anchor = document.getElementById(base);
    if (!anchor) throw Error(`Row ${row + 1} anchor ${base} missing.`);

    const activity = document.getElementById(add(base, 4));
    const attendance = document.getElementById(add(base, 11));
    const hours = [
      ...document.querySelectorAll('input[ct="CBS"][maxlength="20"]'),
    ]
      .filter((element) => sameRow(element, anchor))
      .sort(
        (a, b) =>
          a.getBoundingClientRect().left - b.getBoundingClientRect().left,
      )
      .slice(-7);

    if (!activity) throw Error(`Row ${row + 1} Activity missing.`);
    if (!attendance) throw Error(`Row ${row + 1} Attendance missing.`);
    if (hours.length !== 7)
      throw Error(`Row ${row + 1} has ${hours.length} hour fields.`);

    return {
      anchor,
      activity,
      attendance,
      hours,
      sa: hours[0],
      su: hours[1],
      mo: hours[2],
      tu: hours[3],
      we: hours[4],
      th: hours[5],
      fr: hours[6],
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
      7000,
    );
  }

  function option(text, field) {
    const expected = comparable(text);
    const layer = valueHelpLayer();
    const root = layer || document;
    const selector = "[role='option'],[role='menuitem'],li,td,span,div,a";
    const fieldRect = field.getBoundingClientRect();
    return [
      ...root.querySelectorAll(selector),
    ]
      .filter(
        (element) => {
          if (
            element === field ||
            !visible(element) ||
            element.getAttribute("ct") === "CB" ||
            comparable(element.textContent) !== expected
          ) {
            return false;
          }

          if (layer) return true;

          // SAP's combo popup does not consistently expose a dialog/listbox
          // role. In that build, accept an exact-text element only when it is
          // geometrically close to and below the Att./Abs combo field.
          const rect = element.getBoundingClientRect();
          return (
            rect.top >= fieldRect.top - 8 &&
            rect.top <= fieldRect.bottom + 600 &&
            rect.right >= fieldRect.left - 80 &&
            rect.left <= fieldRect.right + 700
          );
        },
      )
      .sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height,
      )[0];
  }

  function editable(element) {
    return (
      element &&
      visible(element) &&
      !element.disabled &&
      !element.readOnly &&
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement)
    );
  }

  function valueHelpLayer() {
    return [
      ...document.querySelectorAll(
        '[role="listbox"],[role="dialog"],[role="menu"],.urPW,.lsPopupWindow,[ct="PW"],[ct="LB"]',
      ),
    ]
      .filter(visible)
      .sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height,
      )[0];
  }

  function comboState(field) {
    const raw = field?.getAttribute?.("lsdata");
    if (!raw) return { key: "", text: "" };

    try {
      const data = JSON.parse(raw);
      return {
        key: clean(data[4] ?? data["4"]),
        text: clean(data[5] ?? data["5"]),
      };
    } catch (_) {
      return { key: "", text: "" };
    }
  }

  function isSapCombo(field) {
    const controlType = clean(field?.getAttribute?.("ct")).toUpperCase();
    return (
      field instanceof HTMLInputElement &&
      (controlType === "CB" ||
        controlType === "CBS" ||
        field.readOnly ||
        field.hasAttribute("lsdata") ||
        field.classList.contains("lsField__input"))
    );
  }

  function currentControls(base, row) {
    try {
      return controls(base, row);
    } catch (_) {
      return null;
    }
  }

  async function waitForRowState(
    base,
    row,
    label,
    predicate,
    timeout = COMMIT_TIMEOUT,
  ) {
    await sleep(SETTLE);
    return waitFor(
      () => {
        const rowControls = currentControls(base, row);
        return rowControls && predicate(rowControls) ? rowControls : null;
      },
      `Row ${row + 1} ${label}`,
      timeout,
    );
  }

  function hourValueMatches(field, expected) {
    const observed = clean(field?.value);
    const original = clean(expected);
    const numeric = Number(expected);
    return (
      observed === original ||
      (Number.isFinite(numeric) && observed === numeric.toFixed(2))
    );
  }

  function controlDescription(field) {
    return {
      id: clean(field?.id),
      ct: clean(field?.getAttribute?.("ct")),
      className: clean(field?.className),
      readOnly: !!field?.readOnly,
      hasLsdata: !!field?.hasAttribute?.("lsdata"),
    };
  }

  function attendanceValueMatches(field, expected) {
    const wanted = comparable(expected);
    if (!wanted) return clean(field?.value) === "";

    const state = comboState(field);

    const candidates = [
      field?.value,
      field?.getAttribute?.("value"),
      field?.title,
      field?.getAttribute?.("aria-label"),
      state.key,
      state.text,
    ].map(comparable);

    return candidates.some((candidate) => {
      if (!candidate) return false;
      if (candidate === wanted) return true;
      return (
        candidate.startsWith(`${wanted} `) ||
        candidate.startsWith(`${wanted} -`) ||
        candidate.startsWith(`${wanted} –`) ||
        candidate.startsWith(`${wanted}:`)
      );
    });
  }

  function attendanceIsCurrent(base, field, expected) {
    if (attendanceValueMatches(field, expected)) return true;

    const confirmation = confirmedAttendance.get(base);
    return (
      confirmation?.expected === comparable(expected) &&
      clean(field?.value) !== "" &&
      clean(field?.value) === confirmation.display
    );
  }

  async function selectAttendance(data, row, base) {
    const expected = clean(data.att);
    if (!expected) return live(base, row, "Attendance skipped");

    let lastObserved = "";
    let lastError = null;
    let lastControl = null;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      checkStopped();
      try {
        let rowControls = await live(
          base,
          row,
          `Attendance attempt ${attempt}`,
        );
        const field = rowControls.attendance;
        lastControl = controlDescription(field);
        const expectedId = add(base, 11);
        if (field.id !== expectedId) {
          throw Error(
            `wrong Attendance control ${field.id}; expected ${expectedId}`,
          );
        }

        if (attendanceIsCurrent(base, field, expected)) return rowControls;

        click(field);
        f4(field);

        // SAP renders this as a readonly ct="CB" combo box. Assigning .value
        // only changes the display and does not update SAP's selected key.
        // Printable keyboard events drive the combo's native type-ahead, and
        // Enter commits the highlighted item into lsdata (key 4/text 5).
        if (isSapCombo(field)) {
          await sleep(120);

          let exactOption = null;
          // Keyboard type-ahead is fastest and is now the primary route.
          // Use an exact DOM click only on the second attempt as an independent
          // fallback for SAP builds that ignore synthetic printable keys.
          if (attempt === 2) {
            try {
              exactOption = await waitFor(
                () => option(expected, field),
                `Row ${row + 1} exact Attendance option ${expected}`,
                550,
              );
            } catch (error) {
              if (error?.name === "StopError") throw error;
            }
          }

          if (exactOption) {
            click(exactOption);
            await pressEnterAndSettle(
              document.getElementById(field.id) || field,
            );
          } else {
            field.focus();
            await typeKeys(field, expected);
            await pressEnterAndSettle(field);
          }

          rowControls = await waitForRowState(
            base,
            row,
            `Attendance combo verification attempt ${attempt}`,
            (controlsNow) =>
              attendanceValueMatches(controlsNow.attendance, expected),
            ATTENDANCE_TIMEOUT,
          );
          lastObserved = clean(rowControls.attendance.value);

          confirmedAttendance.set(base, {
            expected: comparable(expected),
            display: lastObserved,
          });
          rowControls.mo.focus();
          return rowControls;
        }

        let helpState;
        try {
          helpState = await waitFor(
            () => {
              const exactOption = option(expected, field);
              if (exactOption) return { exactOption };

              const active = document.activeElement;
              if (active !== field && editable(active)) return { editor: active };

              const layer = valueHelpLayer();
              if (!layer) return null;
              const editor = [...layer.querySelectorAll("input,textarea")].find(
                editable,
              );
              return { editor: editor || field };
            },
            `Row ${row + 1} Attendance value help`,
            1200,
          );
        } catch (error) {
          if (error?.name === "StopError") throw error;
          // Some Mercury builds keep focus in the field even though F4 opened
          // its suggestion list. Continue with the field as the typing target.
          helpState = { editor: field };
        }

        let selectedExactOption = false;
        if (helpState.exactOption) {
          click(helpState.exactOption);
          await pressEnterAndSettle(
            document.getElementById(field.id) || field,
          );
          selectedExactOption = true;
        } else {
          const editor = helpState.editor || field;
          click(editor);
          editor.select?.();
          setVal(editor, expected);

          let exactOption = null;
          try {
            exactOption = await waitFor(
              () => option(expected, field),
              `Row ${row + 1} Attendance option ${expected}`,
              700,
            );
          } catch (error) {
            if (error?.name === "StopError") throw error;
          }

          if (exactOption) {
            click(exactOption);
            await pressEnterAndSettle(
              document.getElementById(field.id) || field,
            );
            selectedExactOption = true;
          } else {
            await pressEnterAndSettle(editor);
          }
        }

        rowControls = await waitForRowState(
          base,
          row,
          `Attendance verification attempt ${attempt}`,
          (controlsNow) =>
            attendanceValueMatches(controlsNow.attendance, expected) ||
            (selectedExactOption && clean(controlsNow.attendance.value) !== ""),
          ATTENDANCE_TIMEOUT,
        );
        lastObserved = clean(rowControls.attendance.value);

        if (
          attendanceValueMatches(rowControls.attendance, expected) ||
          (selectedExactOption && lastObserved !== "")
        ) {
          confirmedAttendance.set(base, {
            expected: comparable(expected),
            display: lastObserved,
          });
          rowControls.mo.focus();
          return rowControls;
        }

        throw Error(
          `value was ${lastObserved ? JSON.stringify(lastObserved) : "blank"}`,
        );
      } catch (error) {
        if (error?.name === "StopError") throw error;
        lastError = error;
        esc(document.activeElement || document.body);
        await sleep(120 + attempt * 80);
      }
    }

    throw Error(
      `Row ${row + 1} Attendance ${JSON.stringify(expected)} was not committed after ${ATTEMPTS} attempts` +
        `${lastObserved ? `; field contains ${JSON.stringify(lastObserved)}` : ""}` +
        `${lastError?.message ? ` (${lastError.message})` : ""}. ` +
        `Control=${JSON.stringify(lastControl)}`,
    );
  }

  async function ensureRowContext(data, row, base, label) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      checkStopped();
      let rowControls = await live(
        base,
        row,
        `${label} context attempt ${attempt}`,
      );

      if (clean(rowControls.activity.value) !== clean(data.activity)) {
        await submit(rowControls.activity, data.activity);
        rowControls = await waitForRowState(
          base,
          row,
          `${label} Activity verification`,
          (controlsNow) =>
            clean(controlsNow.activity.value) === clean(data.activity),
        );
      }

      if (
        clean(data.att) &&
        !attendanceIsCurrent(base, rowControls.attendance, data.att)
      ) {
        rowControls = await selectAttendance(data, row, base);
      }

      rowControls = await live(base, row, `${label} final verification`);
      const activityOk =
        clean(rowControls.activity.value) === clean(data.activity);
      const attendanceOk =
        !clean(data.att) ||
        attendanceIsCurrent(base, rowControls.attendance, data.att);

      if (activityOk && attendanceOk) return rowControls;
    }

    const rowControls = await live(base, row, `${label} failed context`);
    throw Error(
      `Row ${row + 1} context did not stabilize. ` +
        `Activity=${JSON.stringify(clean(rowControls.activity.value))}, ` +
        `Attendance=${JSON.stringify(clean(rowControls.attendance.value))}.`,
    );
  }

  function focusables(scope = document) {
    return [
      ...scope.querySelectorAll(
        'input:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],[tabindex="0"],[ct="B"]',
      ),
    ].filter(visible);
  }

  function next(element, scope = document) {
    const elements = focusables(scope);
    const nextElement = elements[elements.indexOf(element) + 1];
    nextElement?.focus?.();
    return nextElement;
  }

  function popup() {
    return [
      ...document.querySelectorAll(
        '[role="dialog"],.urPW,.lsPopupWindow,[ct="PW"],div,table',
      ),
    ]
      .filter(visible)
      .filter((element) =>
        comparable(element.textContent).includes("details"),
      )
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
        hour.focus();
        const trigger = next(hour);
        if (!trigger) throw Error(`${label} details trigger missing.`);
        enter(trigger);

        const detailsPopup = await waitFor(popup, `${label} popup`, 5000);
        const editor = await waitFor(
          () => {
            const active = document.activeElement;
            if (editable(active)) return active;
            return [...detailsPopup.querySelectorAll("textarea,input[type='text']")]
              .filter(visible)
              .find((element) => !element.readOnly);
          },
          `${label} note`,
          5000,
        );

        editor.focus();
        setVal(editor, text);
        await sleep(120);

        const ok =
          next(editor) ||
          focusables(detailsPopup).find(
            (element) =>
              comparable(
                element.innerText ||
                  element.textContent ||
                  element.value ||
                  element.title,
              ) === "ok",
          );
        if (!ok) throw Error(`${label} OK missing.`);
        enter(ok);
        await sleep(400);
        await waitFor(
          () => !visible(detailsPopup),
          `${label} popup close`,
          5000,
        );
        return true;
      } catch (error) {
        if (error?.name === "StopError") throw error;
        lastError = error;
        if (attempt === 1) {
          esc(document.activeElement || document.body);
          await sleep(250);
        }
      }
    }

    runWarnings.push(
      `${label}: ${lastError?.message || "Details popup failed"}`,
    );
    return false;
  }

  function emptyDestination() {
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
  }

  function anchorSnapshot() {
    return anchors()
      .map((anchor) => `${anchor.id}:${clean(anchor.value)}`)
      .join("|");
  }

  async function findNextEmptyEngagementRow() {
    for (let scrollAttempt = 0; scrollAttempt < 50; scrollAttempt++) {
      checkStopped();
      const destination = emptyDestination();
      if (destination) return destination;

      const scrollDown = document.getElementById("WD023A-scrollV-Nxt");
      if (!scrollDown)
        throw Error("Mercury vertical scroll-down button not found.");

      const before = anchorSnapshot();
      click(scrollDown);

      try {
        const result = await waitFor(
          () => {
            const empty = emptyDestination();
            if (empty) return { destination: empty };
            return anchorSnapshot() !== before ? { changed: true } : null;
          },
          "Mercury row grid to scroll",
          650,
        );
        if (result.destination) return result.destination;
      } catch (error) {
        if (error?.name === "StopError") throw error;
        if (
          scrollDown.disabled ||
          comparable(scrollDown.getAttribute("aria-disabled")) === "true"
        ) {
          throw Error("No additional empty Mercury timesheet row is available.");
        }
      }
    }

    throw Error("Unable to locate an empty Mercury timesheet row.");
  }

  async function process(data, destination) {
    const row = destination.rowIndex;
    const anchor = document.getElementById(destination.anchorId);
    if (!anchor || !anchor.isConnected || !visible(anchor)) {
      throw Error(
        `Reserved Mercury row ${row + 1} (${destination.anchorId}) disappeared.`,
      );
    }
    if (clean(anchor.value) !== "") {
      throw Error(
        `Reserved Mercury row ${row + 1} (${destination.anchorId}) is no longer empty.`,
      );
    }

    const base = destination.anchorId;
    confirmedAttendance.delete(base);

    await submit(anchor, data.engagement);
    let rowControls = await waitForRowState(
      base,
      row,
      "Engagement verification",
      (controlsNow) =>
        clean(controlsNow.anchor.value) === clean(data.engagement),
    );
    await submit(rowControls.activity, data.activity);
    rowControls = await waitForRowState(
      base,
      row,
      "Activity verification",
      (controlsNow) =>
        clean(controlsNow.activity.value) === clean(data.activity),
    );
    await ensureRowContext(data, row, base, "initial row");

    const days = [
      ["Saturday", "sa", data.sa, data.saD],
      ["Sunday", "su", data.su, data.suD],
      ["Monday", "mo", data.mo, data.moD],
      ["Tuesday", "tu", data.tu, data.tuD],
      ["Wednesday", "we", data.we, data.weD],
      ["Thursday", "th", data.th, data.thD],
      ["Friday", "fr", data.fr, data.frD],
    ];

    for (const [dayLabel, keyName, hours, note] of days) {
      if (!clean(hours)) continue;

      rowControls = await live(base, row, dayLabel);
      let field = rowControls[keyName];
      await submit(field, hours);

      rowControls = await waitForRowState(
        base,
        row,
        `${dayLabel} hours verification`,
        (controlsNow) => hourValueMatches(controlsNow[keyName], hours),
      );
      field = rowControls[keyName];
      if (!hourValueMatches(field, hours)) {
        throw Error(`Row ${row + 1} ${dayLabel} hours not committed.`);
      }

      // Hour commits and Activity restoration can rerender dependent controls.
      // Revalidate both Activity and Attendance after each such transition.
      await ensureRowContext(data, row, base, `${dayLabel} hours`);
      if (clean(note)) {
        rowControls = await live(base, row, `${dayLabel} details`);
        await details(rowControls[keyName], note, `Row ${row + 1} ${dayLabel}`);
        await ensureRowContext(data, row, base, `${dayLabel} details`);
      }
    }

    await ensureRowContext(data, row, base, "completed row");
    return {
      sourceRow: data.sourceRow,
      mercuryAnchorId: base,
    };
  }

  function frame() {
    try {
      return window.frameElement?.id || window.name || "";
    } catch (_) {
      return window.name || "";
    }
  }

  function probe() {
    const rows = anchors();
    const id = frame();
    return {
      valid:
        rows.length > 0 && !!document.getElementById(add(rows[0]?.id, 11)),
      score: rows.length + (id ? 2 : 0),
      frameElementId: id,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === "STOP") {
      stopRequested = true;
      esc(document.activeElement || document.body);
      respond({ ok: true });
      return;
    }

    if (message?.type === "PROBE") {
      respond(probe());
      return;
    }

    if (message?.type !== "EXEC") return;

    (async () => {
      let done = 0;
      const rowMappings = [];
      stopRequested = false;
      runWarnings.length = 0;
      confirmedAttendance.clear();

      try {
        for (let index = 0; index < message.rows.length; index++) {
          checkStopped();
          const destination = await findNextEmptyEngagementRow();
          const mapping = await process(message.rows[index], destination);
          rowMappings.push(mapping);
          done++;
        }

        respond({
          ok: true,
          completed: done,
          rowMappings,
          warnings: [...runWarnings],
        });
      } catch (error) {
        respond({
          ok: false,
          completed: done,
          error:
            error.name === "StopError"
              ? error.message
              : `Excel row ${message.rows[done]?.sourceRow || "unknown"}: ${error.message}`,
          warnings: [...runWarnings],
        });
      }
    })();
    return true;
  });

  function val(row, ...names) {
    const keyName = Object.keys(row).find((key) =>
      names.some((name) => comparable(key) === comparable(name)),
    );
    return keyName ? row[keyName] : "";
  }

  function norm(row, index) {
    return {
      sourceRow: index + 7,
      engagement: clean(val(row, "Engagement ID")),
      activity: clean(val(row, "Activity ID")),
      att: clean(
        val(
          row,
          "Att./Abs. Type.",
          "Att./Abs. Type",
          "Att/Abs Type",
          "Attendance Type",
        ),
      ),
      sa: clean(val(row, "SA XX")),
      saD: clean(val(row, "Details")),
      su: clean(val(row, "Su XX")),
      suD: clean(val(row, "Details_1")),
      mo: clean(val(row, "Mo XX")),
      moD: clean(val(row, "Details_2")),
      tu: clean(val(row, "Tu XX")),
      tuD: clean(val(row, "Details_3")),
      we: clean(val(row, "We XX")),
      weD: clean(val(row, "Details_4")),
      th: clean(val(row, "Th XX")),
      thD: clean(val(row, "Details_5")),
      fr: clean(val(row, "Fr XX")),
      frD: clean(val(row, "Details_6")),
    };
  }

  function hasExcelData(row) {
    return Object.entries(row).some(
      ([keyName, value]) => keyName !== "sourceRow" && clean(value) !== "",
    );
  }

  function validateExcelRows(rows) {
    const invalid = rows.find((row) => !row.engagement || !row.activity);
    if (!invalid) return;

    const missing = [
      !invalid.engagement ? "Engagement ID" : "",
      !invalid.activity ? "Activity ID" : "",
    ].filter(Boolean);
    throw Error(
      `Excel row ${invalid.sourceRow} contains timesheet data but is missing ${missing.join(
        " and ",
      )}. Each populated Excel row must map to exactly one Mercury row.`,
    );
  }

  function overlay() {
    if (top !== window || document.getElementById("x2m-launcher")) return;

    const style = document.createElement("style");
    style.textContent =
      "#x2m-launcher{position:fixed;right:22px;bottom:22px;width:58px;height:58px;border:0;border-radius:50%;z-index:2147483647;background:#107c41;box-shadow:0 8px 24px #0005;cursor:pointer;color:#fff;font:bold 24px Segoe UI}#x2m-panel{position:fixed;right:22px;bottom:92px;width:330px;z-index:2147483647;background:#fff;border-radius:15px;box-shadow:0 15px 40px #0005;padding:16px;font:13px Segoe UI;display:none}#x2m-panel.open{display:block}#x2m-panel input,#x2m-panel button{width:100%;box-sizing:border-box;margin-top:9px}#x2m-panel button{padding:10px;border:0;border-radius:7px;background:#107c41;color:#fff;font-weight:700}#x2m-stop{background:#c42b1c}#x2m-panel button:disabled{opacity:.55;cursor:not-allowed}#x2m-status{white-space:pre-wrap;margin-top:10px;background:#f3f3f3;padding:9px;border-radius:7px}";
    document.documentElement.appendChild(style);

    const launcher = document.createElement("button");
    launcher.id = "x2m-launcher";
    launcher.textContent = "X";
    launcher.title = `Mercury Automation ${VERSION}`;

    const panel = document.createElement("section");
    panel.id = "x2m-panel";
    panel.innerHTML =
      `<h2>Mercury Automation</h2><div>Version ${VERSION}</div><div>Select template file for import.</div><input id="x2m-file" type="file" accept=".xlsm,.xlsx,.xls"><button id="x2m-run">Run automation</button><button id="x2m-stop" disabled>Stop automation</button><div id="x2m-status">Ready.</div>`;
    document.documentElement.append(panel, launcher);
    launcher.onclick = () => panel.classList.toggle("open");

    const fileInput = panel.querySelector("#x2m-file");
    const runButton = panel.querySelector("#x2m-run");
    const stopButton = panel.querySelector("#x2m-stop");
    const status = panel.querySelector("#x2m-status");

    stopButton.onclick = async () => {
      stopButton.disabled = true;
      status.textContent = "Stopping automation...";
      const output = await chrome.runtime.sendMessage({ type: "STOP" });
      if (!output?.ok) {
        status.textContent = `Unable to stop: ${output?.error || "Unknown error"}`;
      }
    };

    runButton.onclick = async () => {
      if (!fileInput.files[0]) {
        status.textContent = "Select an XLSM, XLSX, or XLS file first.";
        return;
      }

      runButton.disabled = true;
      stopButton.disabled = false;
      try {
        const workbook = XLSX.read(await fileInput.files[0].arrayBuffer(), {
          type: "array",
        });
        const sheet = workbook.Sheets["Mercury Upload"];
        if (!sheet) throw Error('Worksheet "Mercury Upload" was not found.');

        const rows = XLSX.utils
          .sheet_to_json(sheet, {
            range: 5,
            defval: "",
            raw: false,
            blankrows: true,
          })
          .map(norm)
          .filter(hasExcelData);
        if (!rows.length) {
          throw Error('No data found in "Mercury Upload" starting at row 7.');
        }
        validateExcelRows(rows);

        status.textContent = `Appending ${rows.length} row(s) at the next empty Engagement ID row...`;
        const output = await chrome.runtime.sendMessage({
          type: "RUN",
          rows,
        });
        if (!output?.ok) throw Error(output?.error || "Stopped");
        if (
          Array.isArray(output.rowMappings) &&
          output.rowMappings.length !== rows.length
        ) {
          throw Error(
            `Row mapping mismatch: ${rows.length} Excel rows were sent but ` +
              `${output.rowMappings.length} Mercury rows were confirmed.`,
          );
        }

        const warnings = output.warnings || [];
        const mappedCount = Array.isArray(output.rowMappings)
          ? output.rowMappings.length
          : output.completed;
        status.textContent =
          `Completed ${output.completed}/${rows.length} Excel rows\n` +
          `Confirmed ${mappedCount} Mercury rows\nFrame: ${output.frameLabel}` +
          (warnings.length
            ? `\nWarnings (${warnings.length}):\n${warnings
                .map((warning) => `• ${warning}`)
                .join("\n")}`
            : "");
      } catch (error) {
        status.textContent = `Stopped: ${error.message}`;
      } finally {
        runButton.disabled = false;
        stopButton.disabled = true;
      }
    };
  }

  overlay();
})();
