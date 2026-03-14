export type ItemViewMode = "merged" | "series" | "both";
export type CollectionOrderMode = "filename" | "frontmatter";

export interface SiteSettings {
	title: string;
	tagline: string;
	description: string;
	language: string;
	heroEyebrow: string;
	heroTitle: string;
	heroDescription: string;
}

export interface CollectionConfig {
	id: string;
	title: string;
	description: string;
	source: string;
	route: string;
	defaultViewMode: ItemViewMode;
	orderBy: CollectionOrderMode;
	typeLabel: string;
}

export interface AutoBlogConfig {
	site: SiteSettings;
	collections: CollectionConfig[];
}

export interface ParsedMarkdownDocument {
	slug: string;
	title: string;
	description: string;
	html: string;
	raw: string;
	sourcePath: string;
	frontmatter: Record<string, unknown>;
	frontmatterOrder?: number;
	filenameOrder?: number;
	[key: string]: unknown;
}

export interface ContentEntry {
	slug: string;
	title: string;
	description: string;
	html: string;
	raw: string;
	sourcePath: string;
	order: number;
	readingMinutes: number;
}

export interface ContentItem {
	collectionId: string;
	collectionTitle: string;
	collectionRoute: string;
	typeLabel: string;
	slug: string;
	title: string;
	description: string;
	viewMode: ItemViewMode;
	overviewHtml: string;
	mergedHtml: string;
	entries: ContentEntry[];
	readingMinutes: number;
	sourcePath: string;
}

export interface ContentCollection extends CollectionConfig {
	items: ContentItem[];
	itemCount: number;
	entryCount: number;
}

export interface LoadedSite {
	site: SiteSettings;
	collections: ContentCollection[];
}
