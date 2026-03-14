import type { AutoBlogConfig } from "./src/lib/content/types";

const config: AutoBlogConfig = {
	site: {
		title: "Markdown Relay",
		tagline: "Repository-native publishing",
		description:
			"Generate a polished static publication directly from sequential Markdown folders in your repository.",
		language: "en-US",
		heroEyebrow: "Config-driven publishing",
		heroTitle: "Turn repo folders into a deployable learning library.",
		heroDescription:
			"Point collections at Markdown folders, choose whether each item renders as a merged article, a chapter-by-chapter series, or both, and ship straight to a static host.",
	},
	collections: [
		{
			id: "guides",
			title: "Guides",
			description:
				"Structured long-form learning tracks built from ordered Markdown files.",
			source: "content/guides",
			route: "guides",
			defaultViewMode: "both",
			orderBy: "filename",
			typeLabel: "Guide",
		},
	],
};

export default config;
