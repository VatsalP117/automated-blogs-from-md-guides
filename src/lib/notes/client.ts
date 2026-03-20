interface SectionNote {
	id: string;
	pageSlug: string;
	sectionId: string;
	content: string;
	createdAt: string;
	updatedAt: string;
}

const STORAGE_KEY = "autoblog:notes:v1";

export function bootSectionNotes() {
	const scopes = document.querySelectorAll<HTMLElement>("[data-note-scope][data-note-page]");

	if (scopes.length === 0) {
		return;
	}

	const store = new LocalNotesAdapter();

	for (const scope of scopes) {
		if (scope.dataset.noteScopeReady === "true") {
			continue;
		}

		scope.dataset.noteScopeReady = "true";

		const pageSlug = scope.dataset.notePage;

		if (!pageSlug) {
			continue;
		}

		const assignedIds = new Set<string>();
		const headings = scope.querySelectorAll<HTMLHeadingElement>("h2, h3");

		for (const heading of headings) {
			ensureSectionId(heading, assignedIds);

			const noteAddress = resolveNoteAddress(heading, pageSlug);
			enhanceHeading({
				heading,
				pageSlug: noteAddress.pageSlug,
				sectionId: noteAddress.sectionId,
				store,
			});
		}
	}

	if (window.location.hash) {
		const hashTarget = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
		hashTarget?.scrollIntoView({ block: "start" });
	}
}

class LocalNotesAdapter {
	list(pageSlug: string, sectionId: string) {
		return this.read()
			.filter((note) => note.pageSlug === pageSlug && note.sectionId === sectionId)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	upsert(note: SectionNote) {
		const notes = this.read();
		const index = notes.findIndex((candidate) => candidate.id === note.id);

		if (index >= 0) {
			notes[index] = note;
		} else {
			notes.push(note);
		}

		this.write(notes);
	}

	delete(noteId: string) {
		this.write(this.read().filter((note) => note.id !== noteId));
	}

	private read() {
		try {
			const rawNotes = window.localStorage.getItem(STORAGE_KEY);
			const parsed = rawNotes ? JSON.parse(rawNotes) : [];

			return Array.isArray(parsed) ? (parsed as SectionNote[]) : [];
		} catch {
			return [];
		}
	}

	private write(notes: SectionNote[]) {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
	}
}

function enhanceHeading({
	heading,
	pageSlug,
	sectionId,
	store,
}: {
	heading: HTMLHeadingElement;
	pageSlug: string;
	sectionId: string;
	store: LocalNotesAdapter;
}) {
	if (heading.dataset.notesReady === "true") {
		return;
	}

	heading.dataset.notesReady = "true";

	const toolbar = document.createElement("div");
	toolbar.className = "section-note-toolbar";

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "section-note-toggle";
	toolbar.append(toggle);

	const panel = document.createElement("section");
	panel.className = "section-note-panel";
	panel.hidden = true;

	heading.insertAdjacentElement("afterend", toolbar);
	toolbar.insertAdjacentElement("afterend", panel);

	let editingId: string | null = null;

	const render = () => {
		const notes = store.list(pageSlug, sectionId);
		const headingLabel = heading.textContent?.trim() || "This section";
		toggle.innerHTML = `
			<span>${notes.length > 0 ? "Notes" : "Add note"}</span>
			<span class="section-note-count">${notes.length}</span>
		`;

		toggle.classList.toggle("section-note-toggle--active", notes.length > 0);

		const editingNote = editingId ? notes.find((note) => note.id === editingId) : undefined;
		const noteCards = notes
			.map(
				(note) => `
					<li class="section-note-card">
						<div class="section-note-card-head">
							<time datetime="${escapeHtml(note.updatedAt)}">${escapeHtml(
								formatNoteDate(note.updatedAt),
							)}</time>
							<div class="section-note-card-actions">
								<button type="button" data-action="edit" data-note-id="${escapeHtml(note.id)}">Edit</button>
								<button type="button" data-action="delete" data-note-id="${escapeHtml(note.id)}">Delete</button>
							</div>
						</div>
						<p>${escapeHtml(note.content).replace(/\n/g, "<br />")}</p>
					</li>
				`,
			)
			.join("");

		panel.innerHTML = `
			<div class="section-note-panel-head">
				<div>
					<strong>Private notes</strong>
					<p>${escapeHtml(headingLabel)}</p>
				</div>
				<button type="button" class="section-note-close" data-action="close">Close</button>
			</div>
			${notes.length > 0 ? `<ul class="section-note-list">${noteCards}</ul>` : `<p class="section-note-empty">No notes yet for this section.</p>`}
			<form class="section-note-form">
				<label>
					<span>${editingNote ? "Edit note" : "Add note"}</span>
					<textarea name="content" rows="4" placeholder="Capture an insight, question, or follow-up...">${escapeHtml(
						editingNote?.content ?? "",
					)}</textarea>
				</label>
				<div class="section-note-form-actions">
					<button type="submit">${editingNote ? "Save changes" : "Save note"}</button>
					${editingNote ? '<button type="button" data-action="cancel-edit">Cancel</button>' : ""}
				</div>
			</form>
		`;
	};

	toggle.addEventListener("click", () => {
		panel.hidden = !panel.hidden;

		if (!panel.hidden) {
			render();
			panel.querySelector<HTMLTextAreaElement>("textarea")?.focus();
		}
	});

	panel.addEventListener("click", (event) => {
		const target = event.target;

		if (!(target instanceof HTMLElement)) {
			return;
		}

		const action = target.dataset.action;
		const noteId = target.dataset.noteId;

		if (action === "close") {
			panel.hidden = true;
			return;
		}

		if (action === "cancel-edit") {
			editingId = null;
			render();
			return;
		}

		if (action === "edit" && noteId) {
			editingId = noteId;
			render();
			panel.querySelector<HTMLTextAreaElement>("textarea")?.focus();
			return;
		}

		if (action === "delete" && noteId) {
			store.delete(noteId);

			if (editingId === noteId) {
				editingId = null;
			}

			render();
		}
	});

	panel.addEventListener("submit", (event) => {
		event.preventDefault();

		const form = event.target;

		if (!(form instanceof HTMLFormElement)) {
			return;
		}

		const textarea = form.elements.namedItem("content");

		if (!(textarea instanceof HTMLTextAreaElement)) {
			return;
		}

		const content = textarea.value.trim();

		if (!content) {
			textarea.focus();
			return;
		}

		const existingNote = editingId
			? store.list(pageSlug, sectionId).find((note) => note.id === editingId)
			: undefined;
		const now = new Date().toISOString();

		store.upsert({
			id: existingNote?.id ?? createNoteId(),
			pageSlug,
			sectionId,
			content,
			createdAt: existingNote?.createdAt ?? now,
			updatedAt: now,
		});

		editingId = null;
		render();
		form.reset();
	});

	render();
}

function ensureSectionId(heading: HTMLHeadingElement, assignedIds: Set<string>) {
	if (heading.id && !assignedIds.has(heading.id)) {
		assignedIds.add(heading.id);
		return heading.id;
	}

	const mergedSection = heading.closest<HTMLElement>(".merged-section");
	const seed =
		heading.id ||
		(mergedSection?.dataset.entrySlug && heading.parentElement === mergedSection
			? mergedSection.dataset.entrySlug
			: slugifyHeading(heading.textContent || ""));
	const sectionId = uniqueId(seed || "section", assignedIds);

	heading.id = sectionId;
	assignedIds.add(sectionId);

	return sectionId;
}

function uniqueId(seed: string, assignedIds: Set<string>) {
	let nextId = seed;
	let index = 2;

	while (assignedIds.has(nextId)) {
		nextId = `${seed}-${index}`;
		index += 1;
	}

	return nextId;
}

function resolveNoteAddress(heading: HTMLHeadingElement, defaultPageSlug: string) {
	const mergedSection = heading.closest<HTMLElement>(".merged-section");
	const entrySlug = mergedSection?.dataset.entrySlug;

	if (!entrySlug) {
		return {
			pageSlug: defaultPageSlug,
			sectionId: heading.id,
		};
	}

	const prefixedSectionId = heading.id;
	const entryPrefix = `${entrySlug}-`;

	return {
		pageSlug: `${defaultPageSlug}/${entrySlug}`,
		sectionId:
			prefixedSectionId === entrySlug
				? entrySlug
				: prefixedSectionId.startsWith(entryPrefix)
					? prefixedSectionId.slice(entryPrefix.length)
					: prefixedSectionId,
	};
}

function slugifyHeading(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function createNoteId() {
	return window.crypto?.randomUUID?.() ?? `note-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatNoteDate(isoDate: string) {
	try {
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(new Date(isoDate));
	} catch {
		return isoDate;
	}
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
