"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  let state = null,
    editing = null,
    documentRevision = null,
    documentDirty = false,
    documentSaving = false,
    documentSaveBlocked = false,
    documentSaveTimer = null,
    previewMarkdown = null,
    pendingPreviewMarkdown = null,
    previewRequestId = 0,
    refreshing = false,
    mutating = false;
  const decisionDrafts = new Map();
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function add(parent, tag, cls, text) {
    const n = el(tag, cls, text);
    parent.append(n);
    return n;
  }
  function message(text, error = false) {
    $("message").textContent = text;
    $("message").classList.remove("hidden");
    $("message").classList.toggle("error", error);
  }
  async function api(path, method = "GET", data) {
    const response = await fetch("./api" + path, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("Il servizio non è raggiungibile. Riprova tra poco.");
    }
    if (!response.ok) {
      const error = new Error(result.error || "Salvataggio non riuscito.");
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function documentStatus(text, error = false) {
    $("document-status").textContent = text;
    $("document-status").classList.toggle("error", error);
  }
  function scheduleDocumentSave(delay = 600) {
    clearTimeout(documentSaveTimer);
    if (!documentDirty || documentSaveBlocked || documentRevision === null)
      return;
    documentSaveTimer = setTimeout(() => {
      documentSaveTimer = null;
      void flushDocumentSave();
    }, delay);
  }
  async function flushDocumentSave() {
    clearTimeout(documentSaveTimer);
    documentSaveTimer = null;
    if (!documentDirty || documentSaving || documentSaveBlocked || documentRevision === null)
      return;
    documentSaving = true;
    const markdown = $("document-text").value;
    const revision = documentRevision;
    documentStatus("Salvataggio…");
    try {
      const result = await api("/document", "PUT", { markdown, revision });
      documentRevision = result.revision;
      documentDirty = $("document-text").value !== markdown;
      if (documentDirty) {
        documentStatus("Modifiche in corso…");
        // Serialize writes: a later edit uses the revision returned by this save.
        scheduleDocumentSave(250);
      } else documentStatus("Salvato");
    } catch (e) {
      documentDirty = true;
      if (e.status === 409) {
        documentSaveBlocked = true;
        documentStatus(
          "Conflitto: il documento è cambiato altrove. Copia le tue modifiche e ricarica la pagina.",
          true,
        );
      } else if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
        documentSaveBlocked = true;
        documentStatus("Salvataggio rifiutato: " + e.message + " Copia il testo prima di ricaricare.", true);
      } else {
        documentStatus("Salvataggio non riuscito. Nuovo tentativo automatico…", true);
        scheduleDocumentSave(3000);
      }
    } finally {
      documentSaving = false;
    }
  }
  function view(name) {
    if (!["panoramica", "backlog", "decisioni", "documento"].includes(name))
      name = "panoramica";
    if (name !== "documento" && documentDirty) void flushDocumentSave();
    document
      .querySelectorAll(".view")
      .forEach((n) => n.classList.toggle("hidden", n.id !== "view-" + name));
    document.querySelectorAll(".nav-item").forEach((n) => {
      n.classList.toggle("active", n.dataset.view === name);
      if (n.dataset.view === name) n.setAttribute("aria-current", "page");
      else n.removeAttribute("aria-current");
    });
    $("breadcrumb").textContent = name.toUpperCase();
    if (name === "documento") setDocumentMode(true);
  }
  async function updateDocumentPreview() {
    if (
      !state ||
      $("view-documento").classList.contains("hidden") ||
      $("document-preview").classList.contains("hidden")
    ) return;
    const markdown = $("document-text").value;
    if (markdown === previewMarkdown || markdown === pendingPreviewMarkdown)
      return;
    const requestId = ++previewRequestId;
    pendingPreviewMarkdown = markdown;
    try {
      const result = await api("/preview", "POST", { markdown });
      // Ignore obsolete responses if the document changed while rendering.
      if (
        requestId !== previewRequestId ||
        $("document-preview").classList.contains("hidden")
      ) return;
      $("document-preview").innerHTML = result.html;
      previewMarkdown = markdown;
    } catch (e) {
      if (requestId === previewRequestId) message(e.message, true);
    } finally {
      if (requestId === previewRequestId) pendingPreviewMarkdown = null;
    }
  }
  function setDocumentMode(preview) {
    $("document-preview").classList.toggle("hidden", !preview);
    $("document-text").classList.toggle("hidden", preview);
    $("document-editor-label").classList.toggle("hidden", preview);
    $("preview-document").textContent = preview ? "Modifica testo" : "Anteprima";
    if (preview) {
      void updateDocumentPreview();
      if (documentDirty) void flushDocumentSave();
    }
    else {
      ++previewRequestId;
      pendingPreviewMarkdown = null;
      $("document-text").focus();
    }
  }
  async function load({ force = false } = {}) {
    if (refreshing || mutating) return;
    refreshing = true;
    try {
      state = await api("/state");
      $("preview-document").disabled = false;
      renderOverview();
      renderTasks();
      if (force || !document.activeElement.closest(".decision"))
        renderDecisions();
      if (!documentDirty && !documentSaving) {
        // A snapshot initiated before our last save may have an older revision.
        if (documentRevision === null || state.document.revision >= documentRevision) {
          $("document-text").value = state.document.markdown;
          documentRevision = state.document.revision;
          if (!$("document-status").textContent) documentStatus("Salvato");
        }
      } else if (
        !documentSaving &&
        documentRevision !== null &&
        state.document.revision > documentRevision
      ) {
        documentSaveBlocked = true;
        clearTimeout(documentSaveTimer);
        documentStatus(
          "Conflitto: il documento è cambiato altrove. Copia le tue modifiche e ricarica la pagina.",
          true,
        );
      }
      // Keep read-only preview in sync with updates from other team members.
      void updateDocumentPreview();
      $("sync-status").textContent =
        "Aggiornato alle " +
        new Date().toLocaleTimeString("it-IT", {
          hour: "2-digit",
          minute: "2-digit",
        });
    } catch (e) {
      $("sync-status").textContent = "Connessione interrotta";
      if (!state || force) message(e.message, true);
    } finally {
      refreshing = false;
    }
  }
  async function save(action, form, success) {
    if (mutating) return;
    mutating = true;
    const buttons = form ? [...form.querySelectorAll("button")] : [];
    buttons.forEach((b) => (b.disabled = true));
    const error = form?.querySelector(".form-error");
    if (error) error.textContent = "";
    try {
      await action();
      if (success) success();
      $("message").classList.add("hidden");
    } catch (e) {
      if (error) error.textContent = e.message;
      else message(e.message, true);
      return false;
    } finally {
      mutating = false;
      buttons.forEach((b) => (b.disabled = false));
    }
    await load({ force: true });
    return true;
  }
  function renderOverview() {
    const tasks = state.tasks;
    $("stat-total").textContent = tasks.length;
    $("stat-done").textContent = tasks.filter(
      (t) => t.status === "Completato",
    ).length;
    $("stat-active").textContent = tasks.filter((t) =>
      ["In corso", "In verifica"].includes(t.status),
    ).length;
    $("stat-open").textContent = state.decisions.filter(
      (d) => !d.answer.trim(),
    ).length;
    $("nav-tasks").textContent = tasks.length;
    $("nav-decisions").textContent = state.decisions.length;
    $("section-progress").replaceChildren();
    for (const s of state.sections) {
      const list = tasks.filter((t) => t.section_id === s.id),
        done = list.filter((t) => t.status === "Completato").length;
      const row = add($("section-progress"), "div", "progress-item");
      const head = add(row, "div", "progress-head");
      add(head, "strong", "", s.code);
      add(head, "span", "", done + " / " + list.length);
      const bar = add(row, "div", "progress-bar");
      add(bar, "div").style.width =
        (list.length ? (100 * done) / list.length : 0) + "%";
    }
  }
  function renderTasks() {
    const q = $("task-search").value.toLocaleLowerCase("it").trim(),
      status = $("task-status").value,
      priority = $("task-priority").value;
    const tasks = state.tasks.filter(
      (t) =>
        (!q ||
          [t.id, t.title, t.description, t.owner]
            .join(" ")
            .toLocaleLowerCase("it")
            .includes(q)) &&
        (!status || t.status === status) &&
        (!priority || t.priority === priority),
    );
    $("task-count").textContent =
      tasks.length + " di " + state.tasks.length + " attività";
    const root = $("task-sections");
    root.replaceChildren();
    for (const s of state.sections) {
      const list = tasks.filter((t) => t.section_id === s.id);
      if (!list.length && (q || status || priority)) continue;
      const group = add(root, "section", "backlog-section");
      const head = add(group, "div", "section-heading");
      add(head, "h2", "", s.code);
      add(head, "span", "pill", String(list.length));
      const emptySection = !state.tasks.some((t) => t.section_id === s.id);
      const removeSection = add(head, "button", "small-action danger section-remove", "Elimina sezione");
      removeSection.type = "button";
      removeSection.setAttribute("aria-label", "Elimina sezione " + s.code);
      removeSection.disabled = !emptySection;
      removeSection.title = emptySection
        ? "Elimina la sezione vuota " + s.code
        : "Elimina prima tutte le attività della sezione.";
      removeSection.onclick = () => {
        if (confirm("Eliminare definitivamente la sezione vuota " + s.code + "?"))
          save(() => api("/sections/" + s.id, "DELETE", { revision: s.revision }));
      };
      if (!list.length)
        add(
          group,
          "p",
          "empty",
          "Nessuna attività. Usa “+ Attività” per aggiungerne una.",
        );
      for (const t of list) {
        const card = add(group, "article", "task-card");
        card.dataset.id = t.id;
        const title = add(card, "div", "task-summary");
        add(title, "span", "task-id", t.id);
        const open = add(title, "button", "task-title task-open", t.title);
        open.onclick = () => openTask(t);
        const meta = add(card, "div", "task-meta");
        if (t.owner) add(meta, "span", "owner", t.owner);
        add(meta, "span", "priority", t.priority);
        add(meta, "span", "status-badge", t.status);
        const edit = add(meta, "button", "small-action", "Modifica");
        edit.setAttribute("aria-label", "Modifica " + t.id);
        edit.onclick = () => openTask(t);
        const remove = add(meta, "button", "small-action danger", "Elimina");
        remove.setAttribute("aria-label", "Elimina " + t.id);
        remove.onclick = () => {
          if (confirm("Eliminare " + t.id + " — " + t.title + "?"))
            save(() =>
              api("/tasks/" + t.id, "DELETE", { revision: t.revision }),
            );
        };
      }
    }
    if (!root.children.length)
      add(root, "p", "empty", "Nessuna attività corrisponde alla ricerca.");
  }
  function openTask(task = null) {
    editing = task;
    $("task-form").reset();
    $("task-form").querySelector(".form-error").textContent = "";
    $("task-code").textContent = task?.id || "NUOVA ATTIVITÀ";
    $("task-editor-title").textContent = task
      ? "Modifica attività"
      : "Nuova attività";
    $("editor-section").replaceChildren(
      ...state.sections.map((s) => new Option(s.code, s.id)),
    );
    $("editor-section").disabled = !!task;
    if (task) {
      $("editor-section").value = task.section_id;
      $("editor-title").value = task.title;
      $("editor-description").value = task.description;
      $("editor-status").value = task.status;
      $("editor-priority").value = task.priority;
      $("editor-owner").value = task.owner;
    }
    $("task-dialog").showModal();
  }
  function renderDecisions() {
    const q = $("decision-search").value.toLocaleLowerCase("it").trim(),
      root = $("decision-sections");
    root.replaceChildren();
    for (const answered of [false, true]) {
      const group = add(root, "section", "decision-group");
      group.dataset.answered = String(answered);
      const list = state.decisions.filter(
        (d) =>
          !!d.answer.trim() === answered &&
          (!q ||
            [d.code, d.question, d.answer]
              .join(" ")
              .toLocaleLowerCase("it")
              .includes(q)),
      );
      const head = add(group, "div", "section-heading");
      add(head, "h2", "", answered ? "Con risposta" : "Senza risposta");
      add(head, "span", "pill", String(list.length));
      if (!list.length)
        add(group, "p", "empty", "Nessuna domanda in questa sezione.");
      for (const d of list) {
        const draft = decisionDrafts.get(d.id);
        const form = add(group, "form", "decision inline-editor");
        form.dataset.id = d.id;
        add(form, "span", "task-id", d.code || "DOMANDA " + d.id);
        const ql = add(form, "label", "", "Domanda");
        const question = add(ql, "textarea");
        question.rows = 3;
        question.maxLength = 10000;
        question.required = true;
        question.value = draft?.question ?? d.question;
        const al = add(form, "label", "", "Risposta");
        const answer = add(al, "textarea");
        answer.rows = 3;
        answer.maxLength = 20000;
        answer.placeholder = "Scrivi una risposta…";
        answer.value = draft?.answer ?? d.answer;
        add(form, "p", "form-error");
        const actions = add(form, "div", "editor-actions");
        const remove = add(actions, "button", "button danger decision-remove", "Elimina");
        remove.type = "button";
        remove.setAttribute("aria-label", "Elimina decisione " + (d.code || d.id));
        remove.onclick = () => {
          const question = d.question.length > 120 ? d.question.slice(0, 120) + "…" : d.question;
          if (!confirm("Eliminare definitivamente la decisione “" + question + "”?"))
            return;
          const pending = decisionDrafts.get(d.id);
          save(
            () => api("/decisions/" + d.id, "DELETE", { revision: pending?.revision ?? d.revision }),
            form,
            () => decisionDrafts.delete(d.id),
          );
        };
        const reset = add(actions, "button", "button", "Annulla modifiche");
        reset.type = "button";
        reset.hidden = !draft;
        const submit = add(actions, "button", "button primary", "Salva");
        submit.type = "submit";
        submit.disabled = !draft;
        const update = () => {
          decisionDrafts.set(d.id, {
            question: question.value,
            answer: answer.value,
            revision: draft?.revision ?? d.revision,
          });
          submit.disabled = false;
          reset.hidden = false;
        };
        question.oninput = update;
        answer.oninput = update;
        reset.onclick = () => {
          decisionDrafts.delete(d.id);
          renderDecisions();
        };
        form.onsubmit = (e) => {
          e.preventDefault();
          const data = decisionDrafts.get(d.id) || d;
          save(
            () => api("/decisions/" + d.id, "PATCH", data),
            form,
            () => decisionDrafts.delete(d.id),
          );
        };
      }
    }
  }
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        location.hash = b.dataset.view;
        view(b.dataset.view);
      }),
  );
  window.onhashchange = () => view(location.hash.slice(1));
  view(location.hash.slice(1));
  document
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = () => b.closest("dialog").close()));
  for (const id of ["task-search", "task-status", "task-priority"])
    $(id).oninput = () => state && renderTasks();
  $("decision-search").oninput = () => state && renderDecisions();
  $("refresh").onclick = () => load({ force: true });
  $("add-task").onclick = () => {
    if (!state) return;
    if (!state.sections.length) {
      message("Crea prima una sezione.");
      return;
    }
    openTask();
  };
  $("task-form").onsubmit = (e) => {
    e.preventDefault();
    const data = {
      title: $("editor-title").value,
      description: $("editor-description").value,
      status: $("editor-status").value,
      priority: $("editor-priority").value,
      owner: $("editor-owner").value,
      section_id: $("editor-section").value,
      revision: editing?.revision,
    };
    save(
      () =>
        api(
          editing ? "/tasks/" + editing.id : "/tasks",
          editing ? "PATCH" : "POST",
          data,
        ),
      $("task-form"),
      () => $("task-dialog").close(),
    );
  };
  $("add-section").onclick = () => {
    $("section-form").reset();
    $("section-form").querySelector(".form-error").textContent = "";
    $("section-dialog").showModal();
  };
  $("section-form").onsubmit = (e) => {
    e.preventDefault();
    save(
      () =>
        api("/sections", "POST", {
          code: $("section-code").value,
        }),
      $("section-form"),
      () => $("section-dialog").close(),
    );
  };
  $("add-decision").onclick = () => {
    $("new-decision").classList.remove("hidden");
    $("new-question").focus();
  };
  $("cancel-decision").onclick = () => {
    $("new-decision").classList.add("hidden");
    $("new-decision").reset();
  };
  $("new-decision").onsubmit = (e) => {
    e.preventDefault();
    save(
      () =>
        api("/decisions", "POST", {
          question: $("new-question").value,
          answer: $("new-answer").value,
        }),
      $("new-decision"),
      () => {
        $("new-decision").reset();
        $("new-decision").classList.add("hidden");
      },
    );
  };
  $("document-text").oninput = () => {
    documentDirty = true;
    if (documentSaveBlocked) return;
    documentStatus("Modifiche in corso…");
    scheduleDocumentSave();
  };
  $("preview-document").onclick = () =>
    setDocumentMode($("document-preview").classList.contains("hidden"));
  window.addEventListener("visibilitychange", () => {
    if (document.hidden && documentDirty) void flushDocumentSave();
  });
  window.addEventListener("beforeunload", (e) => {
    if (documentDirty || documentSaving || decisionDrafts.size) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  load();
  setInterval(() => {
    if (!document.hidden && !document.querySelector("dialog[open]")) load();
  }, 5000);
  window.addEventListener("focus", () => load());
})();
