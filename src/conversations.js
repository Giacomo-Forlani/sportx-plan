"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const storageKey = "sportx.conversations.developer";
  const date = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });
  const threadUrl = (id) => "#conversazioni/" + id;
  const drafts = new Map();
  let developer = "";
  try { developer = localStorage.getItem(storageKey) ?? ""; } catch { /* Local storage may be disabled. */ }
  let inbox, thread, activeId, visible;
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

  async function api(path = "", method = "GET", data) {
    const headers = developer ? { "X-SportX-Developer": developer } : {};
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

  function renderInbox() {
    const signedIn = Boolean(inbox);
    $("conversation-login").classList.toggle("hidden", signedIn);
    $("conversation-workspace").classList.toggle("hidden", !signedIn);
    const unread = inbox?.threads.filter((item) => item.unread).length ?? 0;
    $("nav-conversations").classList.toggle("hidden", !unread);
    $("nav-conversations").textContent = unread || "";
    if (!signedIn) return;

    $("conversation-account").textContent = "Casella di " + inbox.me.name;
    $("conversation-new").classList.toggle("hidden", inbox.members.length < 2);
    const filter = $("conversation-filter").value;
    const data = inbox.threads.filter((item) => filter === "all" ||
      (filter === "unread" ? item.unread : item.waiting_for_you));
    const signature = JSON.stringify([activeId, filter, data]);
    if (signature === renderedList) return;
    renderedList = signature;

    const list = $("conversation-list");
    list.replaceChildren();
    if (!data.length) {
      const empty = {
        all: "La tua casella è vuota.",
        unread: "Nessuna conversazione non letta.",
        waiting: "Nessuna conversazione in attesa di te.",
      };
      list.append(element("li", empty[filter], "conversation-empty"));
    }
    for (const item of data) {
      const li = element("li");
      const link = element("a", "", "conversation-item");
      link.href = threadUrl(item.id);
      if (item.id === activeId) link.setAttribute("aria-current", "page");
      const heading = element("span", "", "conversation-item-heading");
      heading.append(element("strong", item.subject));
      if (item.unread) heading.append(element("span", "Non letta", "conversation-tag"));
      const other = item.participants.find(({ id }) => id !== inbox.me.id);
      const label = item.waiting_for_you ? " · In attesa di te" : "";
      link.append(heading, element("span", other.name + label, "conversation-meta"));
      link.append(element("span", item.preview || "Conferma del contratto", "conversation-snippet"));
      li.append(link);
      list.append(li);
    }
  }

  function renderThread(empty = "Seleziona una conversazione.") {
    $("conversation-thread").classList.toggle("hidden", !thread);
    $("conversation-empty").classList.toggle("hidden", Boolean(thread));
    $("conversation-empty").textContent = empty;
    if (!thread) {
      renderedThread = "";
      return;
    }
    const signature = JSON.stringify(thread);
    if (signature === renderedThread) return;
    renderedThread = signature;

    const names = Object.fromEntries(thread.participants.map(({ id, name }) => [id, name]));
    $("conversation-subject").textContent = thread.subject;
    $("conversation-participants").textContent =
      [thread.kind === "notice" ? "Avviso" : "Domanda", ...Object.values(names)].join(" · ");
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
    $("conversation-read").classList.toggle("hidden", !thread.unread);

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
      $("agreement-confirm").classList.toggle("hidden", thread.confirmed_by.includes(inbox.me.id));
    }

    const messages = $("conversation-messages");
    messages.replaceChildren();
    for (const item of thread.messages) {
      const li = element("li", "", "conversation-message");
      const header = element("div", "", "conversation-message-header");
      header.append(element("strong", names[item.author_id]));
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
  }

  function clearDeveloper() {
    generation++;
    developer = "";
    inbox = undefined;
    thread = undefined;
    drafts.clear();
    renderedList = "";
    try { localStorage.removeItem(storageKey); } catch { /* The in-memory identity was cleared. */ }
    $("conversation-developer").value = "";
    $("conversation-reply").reset();
    $("conversation-dialog").close();
    $("conversation-messages").replaceChildren();
    $("agreement-text").textContent = "";
    $("conversation-list").replaceChildren();
    $("conversation-new").classList.add("hidden");
    renderInbox();
    renderThread();
  }

  async function refresh() {
    if (!developer || loading || writing) return;
    loading = true;
    const request = generation;
    const id = visible ? activeId : undefined;
    let inboxLoaded = false;
    try {
      const updated = await api();
      if (request !== generation) return;
      inboxLoaded = true;
      inbox = updated;
      renderInbox();
      if (id) {
        const detail = await api("/" + id);
        if (request !== generation || !visible || id !== activeId) return;
        thread = detail;
        renderThread();
      }
    } catch (error) {
      if (request !== generation) return;
      if (!inboxLoaded && [400, 404].includes(error.status)) clearDeveloper();
      if (inboxLoaded && error.status === 404 && id === activeId) {
        thread = undefined;
        renderThread("Conversazione non disponibile.");
      } else status(error.message, true);
    } finally {
      loading = false;
      if (request !== generation && developer) void refresh();
    }
  }

  function navigate(isVisible, id) {
    const nextId = id && /^[a-f0-9-]{36}$/.test(id) ? id : undefined;
    const changedThread = nextId !== activeId;
    if (changedThread) {
      if (activeId && $("conversation-reply-text").value) drafts.set(activeId, {
        text: $("conversation-reply-text").value, kind: $("conversation-reply-kind").value,
      });
      activeId = nextId;
      thread = undefined;
      $("conversation-reply-text").value = drafts.get(activeId)?.text ?? "";
      $("conversation-reply-kind").value = drafts.get(activeId)?.kind ?? "reply";
      renderThread(activeId ? "Caricamento conversazione…" : undefined);
      renderInbox();
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

  $("conversation-login").onsubmit = (event) => {
    event.preventDefault();
    if (loading || writing) return;
    const name = $("conversation-developer").value;
    void submit(event.submitter, () => api("/developers", "POST", { name }), ({ id }) => {
      developer = id;
      $("conversation-developer").value = "";
      try { localStorage.setItem(storageKey, developer); } catch { /* The current tab remains connected. */ }
    });
  };
  $("conversation-logout").onclick = () => {
    if (writing) return;
    clearDeveloper();
    status("");
    location.hash = "conversazioni";
  };
  $("conversation-filter").onchange = renderInbox;
  $("conversation-new").onclick = () => {
    const form = $("conversation-compose");
    form.reset();
    form.querySelector(".form-error").textContent = "";
    const recipients = inbox.members.filter(({ id }) => id !== inbox.me.id);
    const select = $("conversation-recipient");
    select.replaceChildren(new Option("Scegli uno sviluppatore", ""),
      ...recipients.map(({ id, name }) => new Option(name === id ? name : name + " (" + id + ")", id)));
    $("conversation-dialog").showModal();
  };
  $("conversation-compose").onsubmit = (event) => {
    event.preventDefault();
    void submit(event.submitter, () => api("", "POST", {
      recipient: $("conversation-recipient").value,
      subject: $("conversation-new-subject").value,
      reference: $("conversation-new-reference").value,
      kind: $("conversation-kind").value,
      message: $("conversation-new-text").value,
    }), ({ id }) => {
      $("conversation-dialog").close();
      location.hash = threadUrl(id);
      status("Messaggio inviato.");
    }, event.currentTarget.querySelector(".form-error"));
  };
  $("conversation-reply").onsubmit = (event) => {
    event.preventDefault();
    const { id, agreement_version: version } = thread;
    const proposal = $("conversation-reply-kind").value === "proposal";
    const message = $("conversation-reply-text").value;
    void submit(event.submitter, () => api("/" + id + (proposal ? "/proposal" : "/replies"), "POST",
      proposal ? { message, version } : { message }), () => {
      drafts.delete(id);
      if (id === activeId && $("conversation-reply-text").value === message) $("conversation-reply").reset();
      status(proposal ? "Proposta pubblicata." : "Risposta inviata.");
    });
  };
  $("conversation-read").onclick = (event) => {
    const { id, messages } = thread;
    void submit(event.currentTarget, () => api("/" + id + "/read", "POST",
      { through_id: messages.at(-1).id }), () => status("Conversazione segnata come letta."));
  };
  $("agreement-confirm").onclick = (event) => {
    const { id, agreement_version: version } = thread;
    void submit(event.currentTarget, () => api("/" + id + "/confirmation", "POST", { version }),
      () => status("Versione " + version + " confermata."));
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
