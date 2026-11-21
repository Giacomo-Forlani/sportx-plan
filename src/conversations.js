"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = "sportx.conversations.developer";
  const date = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });
  const threadUrl = (id) => "#conversazioni/" + id;
  const drafts = new Map();
  let sender = "";
  try { sender = localStorage.getItem(storageKey) ?? ""; } catch { /* Storage may be disabled. */ }
  let board, thread, activeId, visible;
  let generation = 0;
  let loading = false;
  let writing = false;
  let renderedList = "";
  let renderedThread = "";

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function status(text, error = false) {
    $("conversation-status").textContent = text;
    $("conversation-status").classList.toggle("error", error);
  }

  async function api(path, method = "GET", data, author) {
    const headers = author ? { "X-SportX-Developer": author } : {};
    if (data) headers["Content-Type"] = "application/json";
    const response = await fetch("./api/conversations" + path, {
      method, headers, body: data ? JSON.stringify(data) : undefined,
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error("Il servizio non è raggiungibile. Riprova tra poco."); }
    if (!response.ok) {
      const error = new Error(result.error);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function renderBoard() {
    if (!board) return;
    $("conversation-new").classList.toggle("hidden", board.members.length < 2);
    const pending = board.threads.filter(({ unread_by, waiting_by }) => unread_by.length || waiting_by.length).length;
    $("nav-conversations").classList.toggle("hidden", !pending);
    $("nav-conversations").textContent = pending || "";

    const filter = $("conversation-filter").value;
    const signature = JSON.stringify([activeId, filter, board.sections, board.threads]);
    if (signature === renderedList) return;
    renderedList = signature;
    const container = $("conversation-sections");
    container.replaceChildren();
    if (!board.sections.length) {
      container.append(element("p", "Nessun thread del team.", "conversation-empty"));
      return;
    }

    for (const group of board.sections) {
      const memberIds = new Set(group.member_ids);
      const items = board.threads.filter(({ participants }) => participants.some(({ id }) => memberIds.has(id)))
        .map((item) => ({
          item,
          unread: item.unread_by.some((id) => memberIds.has(id)),
          waiting: item.waiting_by.some((id) => memberIds.has(id)),
        }));
      const section = element("section", "", "conversation-team-section");
      const heading = element("h3", "", "conversation-team-heading");
      heading.append(element("span", group.name));
      const count = items.filter(({ unread, waiting }) => unread || waiting).length;
      if (count) heading.append(element("span", count + " in attesa", "conversation-tag waiting"));
      section.append(heading);
      const shown = items.filter(({ unread, waiting }) =>
        filter === "all" || (filter === "unread" ? unread : waiting));
      if (!shown.length) section.append(element("p", filter === "all"
        ? "Nessun thread." : "Nessun thread con questo stato.", "conversation-empty"));

      const list = element("ul", "", "conversation-list");
      for (const { item, unread, waiting } of shown) {
        const li = element("li");
        const link = element("a", "", "conversation-item");
        link.href = threadUrl(item.id);
        if (item.id === activeId) link.setAttribute("aria-current", "page");
        link.append(element("strong", item.subject));
        const [from, to] = item.participants;
        link.append(element("span", "Da " + from.name + " · A " + to.name, "conversation-meta"));
        if (unread || waiting) {
          const tags = element("span", "", "conversation-tags");
          if (unread) tags.append(element("span", "Da leggere", "conversation-tag"));
          if (waiting) tags.append(element("span", item.waiting_for === "confirmation"
            ? "Da confermare" : "In attesa di risposta", "conversation-tag waiting"));
          link.append(tags);
        }
        link.append(element("span", item.preview || "Conferma del contratto", "conversation-snippet"));
        li.append(link);
        list.append(li);
      }
      if (list.childElementCount) section.append(list);
      container.append(section);
    }
  }

  function setOptions(select, members, placeholder, selected = "") {
    select.replaceChildren(new Option(placeholder, ""),
      ...members.map(({ id, name }) => new Option(name, id)));
    select.value = members.some(({ id }) => id === selected) ? selected : "";
  }

  function remember(author) {
    if (!author) return;
    sender = author;
    try { localStorage.setItem(storageKey, sender); } catch { /* A choice can still be used in this tab. */ }
  }

  function syncReplyActions() {
    if (!thread) return;
    const author = $("conversation-reply-sender").value;
    const to = author && thread.participants.find(({ id }) => id !== author);
    $("conversation-reply-recipient").textContent = to ? "A " + to.name : "";
    $("conversation-read").classList.toggle("hidden", !thread.unread_by.includes(author));
    $("agreement-confirm").classList.toggle("hidden", !author || !thread.agreement_version ||
      thread.confirmed_by.includes(author));
  }

  function renderThread(empty = "Seleziona un thread.") {
    $("conversation-thread").classList.toggle("hidden", !thread);
    $("conversation-empty").classList.toggle("hidden", Boolean(thread));
    $("conversation-empty").textContent = empty;
    if (!thread) {
      renderedThread = "";
      return;
    }
    const signature = JSON.stringify(thread);
    if (signature === renderedThread) return;
    const firstRender = !renderedThread;
    renderedThread = signature;

    const names = Object.fromEntries(thread.participants.map(({ id, name }) => [id, name]));
    const [from, to] = thread.participants;
    const subject = $("conversation-subject");
    subject.textContent = thread.subject;
    $("conversation-participants").textContent = "Da " + from.name + " · A " + to.name;
    const reference = $("conversation-reference");
    reference.replaceChildren();
    reference.classList.toggle("hidden", !thread.reference);
    if (thread.reference) {
      reference.append("Riferimento ");
      if (/^https?:\/\//i.test(thread.reference)) {
        const link = element("a", thread.reference);
        link.href = thread.reference;
        reference.append(link);
      } else reference.append(thread.reference);
    }

    const version = thread.agreement_version;
    $("conversation-agreement").classList.toggle("hidden", !version);
    if (version) {
      const agreed = thread.confirmed_by.length === thread.participants.length;
      const proposal = thread.messages.find((item) =>
        item.kind === "proposal" && item.agreement_version === version);
      $("agreement-title").textContent = (agreed ? "Accordo confermato" : "Proposta di contratto") + " · v" + version;
      $("agreement-text").textContent = proposal.body;
      $("agreement-approvals").textContent = agreed
        ? "Confermato da " + thread.confirmed_by.map((id) => names[id]).join(" e ")
        : "In attesa di " + thread.participants.filter(({ id }) => !thread.confirmed_by.includes(id))
          .map(({ name }) => name).join(" e ");
    }

    const messages = $("conversation-messages");
    messages.replaceChildren();
    for (const item of thread.messages) {
      const li = element("li", "", "conversation-message");
      const header = element("div", "", "conversation-message-header");
      header.append(element("strong", "Da " + names[item.author_id] + " · A " + names[item.recipient_id]));
      const time = element("time", date.format(new Date(item.created_at)));
      time.dateTime = item.created_at;
      header.append(time);
      li.append(header);
      if (item.kind === "confirmation")
        li.append(element("p", "Ha confermato la versione " + item.agreement_version + ".", "conversation-meta"));
      if (item.kind === "proposal")
        li.append(element("p", "Proposta di contratto · v" + item.agreement_version, "conversation-meta"));
      if (item.body) li.append(element("p", item.body, "conversation-body"));
      messages.append(li);
    }

    if (firstRender) {
      setOptions($("conversation-reply-sender"), thread.participants, "Scegli il mittente",
        drafts.get(activeId)?.author ?? sender);
      subject.focus();
    }
    syncReplyActions();
  }

  async function refresh() {
    if (!visible || loading || writing) return;
    loading = true;
    const request = generation;
    const id = activeId;
    let boardLoaded = false;
    try {
      const updated = await api("/board");
      if (request !== generation) return;
      boardLoaded = true;
      board = updated;
      renderBoard();
      if (id) {
        const detail = await api("/board/" + id);
        if (request !== generation) return;
        thread = detail;
        renderThread();
      }
    } catch (error) {
      if (request !== generation) return;
      if (boardLoaded && error.status === 404) {
        thread = undefined;
        renderThread("Conversazione non disponibile.");
      } else status(error.message, true);
    } finally {
      loading = false;
      if (request !== generation) void refresh();
    }
  }

  function navigate(isVisible, id) {
    const nextId = id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) ? id : undefined;
    const changedThread = nextId !== activeId;
    if (changedThread) {
      if (activeId && $("conversation-reply-text").value) drafts.set(activeId, {
        text: $("conversation-reply-text").value, kind: $("conversation-reply-kind").value,
        author: $("conversation-reply-sender").value,
      });
      activeId = nextId;
      thread = undefined;
      $("conversation-reply-text").value = drafts.get(activeId)?.text ?? "";
      $("conversation-reply-kind").value = drafts.get(activeId)?.kind ?? "reply";
      renderThread(activeId ? "Caricamento conversazione…" : undefined);
      renderBoard();
    }
    if (visible !== isVisible || changedThread) {
      generation++;
      visible = isVisible;
      if (visible) void refresh();
    }
  }

  async function submit(button, action, done, errorTarget) {
    if (writing) return;
    writing = true;
    button.disabled = true;
    if (errorTarget) errorTarget.textContent = "";
    else status("");
    try {
      const result = await action();
      generation++;
      done(result);
    } catch (error) {
      if (errorTarget) errorTarget.textContent = error.message;
      else status(error.message, true);
    } finally {
      writing = false;
      button.disabled = false;
      void refresh();
    }
  }

  $("conversation-filter").onchange = renderBoard;
  $("conversation-reply-sender").onchange = syncReplyActions;
  $("conversation-sender").onchange = () => {
    const author = $("conversation-sender").value;
    const recipients = board.members.filter(({ id }) => id !== author);
    setOptions($("conversation-recipient"), recipients, "Scegli il destinatario", $("conversation-recipient").value);
  };
  $("conversation-new").onclick = () => {
    const form = $("conversation-compose");
    form.reset();
    form.querySelector(".form-error").textContent = "";
    setOptions($("conversation-sender"), board.members, "Scegli il mittente", sender);
    $("conversation-sender").onchange();
    $("conversation-dialog").showModal();
  };
  $("conversation-compose").onsubmit = (event) => {
    event.preventDefault();
    const author = $("conversation-sender").value;
    void submit(event.submitter, () => api("", "POST", {
      recipient: $("conversation-recipient").value,
      subject: $("conversation-new-subject").value,
      reference: $("conversation-new-reference").value,
      kind: $("conversation-kind").value,
      message: $("conversation-new-text").value,
    }, author), ({ id }) => {
      remember(author);
      $("conversation-dialog").close();
      location.hash = threadUrl(id);
      status("Messaggio inviato.");
    }, event.currentTarget.querySelector(".form-error"));
  };
  $("conversation-reply").onsubmit = (event) => {
    event.preventDefault();
    const { id, agreement_version: version } = thread;
    const author = $("conversation-reply-sender").value;
    const proposal = $("conversation-reply-kind").value === "proposal";
    const message = $("conversation-reply-text").value;
    void submit(event.submitter, () => api("/" + id + (proposal ? "/proposal" : "/replies"), "POST",
      proposal ? { message, version } : { message }, author), () => {
      remember(author);
      drafts.delete(id);
      if (id === activeId && $("conversation-reply-text").value === message) {
        $("conversation-reply-text").value = "";
        $("conversation-reply-kind").value = "reply";
      }
      status(proposal ? "Proposta pubblicata." : "Risposta inviata.");
    });
  };
  $("conversation-read").onclick = (event) => {
    const { id, messages } = thread;
    const author = $("conversation-reply-sender").value;
    void submit(event.currentTarget, () => api("/" + id + "/read", "POST",
      { through_id: messages.at(-1).id }, author), () => {
      remember(author);
      status("Messaggi segnati come letti.");
    });
  };
  $("agreement-confirm").onclick = (event) => {
    const { id, agreement_version: version } = thread;
    const author = $("conversation-reply-sender").value;
    void submit(event.currentTarget, () => api("/" + id + "/confirmation", "POST", { version }, author), () => {
      remember(author);
      status("Versione " + version + " confermata.");
    });
  };
  $("conversation-link").onclick = async () => {
    try {
      await navigator.clipboard.writeText(new URL(threadUrl(thread.id), location.href).href);
      status("Link copiato.");
    } catch {
      status("Puoi copiare il link dalla barra degli indirizzi.", true);
    }
  };

  window.sportxConversations = { navigate, refresh };
})();
