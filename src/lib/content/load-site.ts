import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { siteConfig } from "@/lib/config";
import type {
	CollectionConfig,
	ContentCollection,
	ContentEntry,
	ContentItem,
	LoadedSite,
	ParsedMarkdownDocument,
} from "@/lib/content/types";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const ITEM_META_FILENAMES = new Set([
	"index.md",
	"index.markdown",
	"_index.md",
	"_index.markdown",
]);

let siteCache: Promise<LoadedSite> | undefined;

marked.setOptions({
	gfm: true,
});

export function loadSiteContent(): Promise<LoadedSite> {
	siteCache ??= buildSiteContent();
	return siteCache;
}

async function buildSiteContent(): Promise<LoadedSite> {
	const collections = await Promise.all(siteConfig.collections.map(loadCollection));

	return {
		site: siteConfig.site,
		collections,
	};
}

async function loadCollection(collection: CollectionConfig): Promise<ContentCollection> {
	const sourceDirectory = path.resolve(process.cwd(), collection.source);
	const directoryEntries = await safeReadDir(sourceDirectory);

	const itemCandidates = directoryEntries
		.filter((entry) => !entry.name.startsWith("."))
		.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

	const items = (
		await Promise.all(
			itemCandidates.map(async (entry) => {
				const absolutePath = path.join(sourceDirectory, entry.name);

				if (entry.isDirectory()) {
					return loadDirectoryItem(collection, absolutePath, entry.name);
				}

				if (entry.isFile() && isMarkdownPath(entry.name)) {
					return loadSingleFileItem(collection, absolutePath);
				}

				return undefined;
			}),
		)
	).filter(Boolean) as ContentItem[];

	return {
		...collection,
		items,
		itemCount: items.length,
		entryCount: items.reduce((total, item) => total + item.entries.length, 0),
	};
}

async function loadDirectoryItem(
	collection: CollectionConfig,
	itemPath: string,
	folderName: string,
): Promise<ContentItem | undefined> {
	const entries = await safeReadDir(itemPath);
	const markdownFiles = entries
		.filter((entry) => entry.isFile() && isMarkdownPath(entry.name))
		.map((entry) => path.join(itemPath, entry.name));

	if (markdownFiles.length === 0) {
		return undefined;
	}

	const metaPath = markdownFiles.find((filePath) => ITEM_META_FILENAMES.has(path.basename(filePath)));
	const contentPaths =
		markdownFiles.length === 1 && metaPath
			? markdownFiles
			: markdownFiles.filter((filePath) => filePath !== metaPath);

	const overviewDocument =
		metaPath && contentPaths !== markdownFiles ? await readMarkdownDocument(metaPath) : undefined;
	const parsedEntries = await Promise.all(contentPaths.map((filePath) => readMarkdownDocument(filePath)));
	const contentEntries = sortDocuments(parsedEntries, collection.orderBy).map((entry, index) =>
		buildContentEntry(entry, index),
	);

	if (contentEntries.length === 0) {
		return undefined;
	}

	const firstEntry = contentEntries[0];
	const itemSlug = slugify(pickFrontmatterString(overviewDocument, "slug") ?? folderName);
	const itemTitle =
		pickString(overviewDocument, "title") ??
		pickString(parsedEntries[0], "seriesTitle") ??
		prettifySlug(folderName);
	const itemDescription =
		pickString(overviewDocument, "description") ??
		firstEntry.description ??
		`${itemTitle} rendered from ${contentEntries.length} Markdown files.`;
	const viewMode =
		normalizeViewMode(
			pickFrontmatterString(overviewDocument, "viewMode") ??
				pickFrontmatterString(parsedEntries[0], "viewMode"),
		) ?? collection.defaultViewMode;
	const overviewHtml = overviewDocument?.html ?? "";

	return {
		collectionId: collection.id,
		collectionTitle: collection.title,
		collectionRoute: collection.route,
		typeLabel: collection.typeLabel,
		slug: itemSlug,
		title: itemTitle,
		description: itemDescription,
		viewMode,
		overviewHtml,
		mergedHtml: buildMergedHtml(contentEntries),
		entries: contentEntries,
		readingMinutes: contentEntries.reduce((total, entry) => total + entry.readingMinutes, 0),
		sourcePath: itemPath,
	};
}

async function loadSingleFileItem(
	collection: CollectionConfig,
	filePath: string,
): Promise<ContentItem> {
	const document = await readMarkdownDocument(filePath);
	const entry = buildContentEntry(document, 0);
	const viewMode = normalizeViewMode(pickFrontmatterString(document, "viewMode")) ?? "merged";

	return {
		collectionId: collection.id,
		collectionTitle: collection.title,
		collectionRoute: collection.route,
		typeLabel: collection.typeLabel,
		slug: document.slug,
		title: document.title,
		description: document.description,
		viewMode,
		overviewHtml: "",
		mergedHtml: buildMergedHtml([entry]),
		entries: [entry],
		readingMinutes: entry.readingMinutes,
		sourcePath: filePath,
	};
}

async function readMarkdownDocument(filePath: string): Promise<ParsedMarkdownDocument> {
	const source = await fs.readFile(filePath, "utf8");
	const parsed = matter(source);
	const firstHeading = extractFirstHeading(parsed.content);
	const title =
		readString(parsed.data.title) ??
		firstHeading ??
		prettifySlug(path.basename(filePath, path.extname(filePath)));
	const description =
		readString(parsed.data.description) ??
		createExcerpt(parsed.content) ??
		`${title} from ${path.basename(filePath)}.`;
	const slug = slugify(readString(parsed.data.slug) ?? path.basename(filePath, path.extname(filePath)));
	const normalizedContent = stripLeadingHeading(parsed.content);

	return {
		slug,
		title,
		description,
		html: marked.parse(normalizedContent) as string,
		raw: normalizedContent,
		sourcePath: filePath,
		frontmatter: parsed.data as Record<string, unknown>,
		frontmatterOrder: readNumber(parsed.data.order),
		filenameOrder: inferFilenameOrder(path.basename(filePath)),
		...(parsed.data as Record<string, unknown>),
	};
}

function buildContentEntry(entry: ParsedMarkdownDocument, index: number): ContentEntry {
	const order = entry.frontmatterOrder ?? entry.filenameOrder ?? index + 1;

	return {
		slug: entry.slug,
		title: entry.title,
		description: entry.description,
		html: entry.html,
		raw: entry.raw,
		sourcePath: entry.sourcePath,
		order,
		readingMinutes: estimateReadingTime(entry.raw),
	};
}

function buildMergedHtml(entries: ContentEntry[]): string {
	return entries
		.map(
			(entry, index) => `
				<section class="merged-section" id="${escapeHtml(entry.slug)}">
					<p class="kicker">Part ${index + 1}</p>
					<h2>${escapeHtml(entry.title)}</h2>
					${entry.html}
				</section>
			`,
		)
		.join("\n");
}

function sortDocuments(entries: ParsedMarkdownDocument[], orderBy: CollectionConfig["orderBy"]) {
	return [...entries].sort((left, right) => {
		const [leftPrimary, leftSecondary] =
			orderBy === "frontmatter"
				? [left.frontmatterOrder, left.filenameOrder]
				: [left.filenameOrder, left.frontmatterOrder];
		const [rightPrimary, rightSecondary] =
			orderBy === "frontmatter"
				? [right.frontmatterOrder, right.filenameOrder]
				: [right.filenameOrder, right.frontmatterOrder];

		return (
			normalizeSortNumber(leftPrimary) - normalizeSortNumber(rightPrimary) ||
			normalizeSortNumber(leftSecondary) - normalizeSortNumber(rightSecondary) ||
			left.sourcePath.localeCompare(right.sourcePath, undefined, { numeric: true })
		);
	});
}

function normalizeSortNumber(value?: number) {
	return value ?? Number.MAX_SAFE_INTEGER;
}

function isMarkdownPath(fileName: string) {
	return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function safeReadDir(directoryPath: string) {
	try {
		return await fs.readdir(directoryPath, { withFileTypes: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read content from ${directoryPath}: ${message}`);
	}
}

function extractFirstHeading(content: string) {
	const match = content.match(/^\s*#\s+(.+)$/m);
	return match?.[1]?.trim();
}

function stripLeadingHeading(content: string) {
	const lines = content.split("\n");
	let index = 0;

	while (index < lines.length && lines[index].trim() === "") {
		index += 1;
	}

	if (index < lines.length && /^\s*#\s+/.test(lines[index])) {
		lines.splice(index, 1);

		while (index < lines.length && lines[index].trim() === "") {
			lines.splice(index, 1);
		}
	}

	return lines.join("\n").trim();
}

function createExcerpt(content: string) {
	const normalized = stripMarkdown(content)
		.replace(/\s+/g, " ")
		.trim();

	if (!normalized) {
		return "";
	}

	return normalized.slice(0, 180).trimEnd() + (normalized.length > 180 ? "..." : "");
}

function stripMarkdown(content: string) {
	return content
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[.*?\]\(.*?\)/g, " ")
		.replace(/\[(.*?)\]\(.*?\)/g, "$1")
		.replace(/^>\s?/gm, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_~>-]/g, " ");
}

function estimateReadingTime(content: string) {
	const words = stripMarkdown(content)
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;

	return Math.max(1, Math.ceil(words / 220));
}

function inferFilenameOrder(fileName: string) {
	const match = fileName.match(/^(\d+)/);
	return match ? Number(match[1]) : undefined;
}

function slugify(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/^\d+\s*[-_.]?\s*/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function prettifySlug(value: string) {
	return value
		.replace(/^\d+\s*[-_.]?\s*/, "")
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

function readString(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickString(source: Record<string, unknown> | undefined, key: string) {
	return source ? readString(source[key]) : undefined;
}

function pickFrontmatterString(source: ParsedMarkdownDocument | undefined, key: string) {
	return source ? readString(source.frontmatter[key]) : undefined;
}

function normalizeViewMode(value?: string) {
	return value === "merged" || value === "series" || value === "both" ? value : undefined;
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
