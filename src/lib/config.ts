import { z } from "zod";
import rawConfig from "../../autoblog.config";
import type { AutoBlogConfig } from "@/lib/content/types";

const siteSchema = z.object({
	title: z.string().min(1),
	tagline: z.string().min(1),
	description: z.string().min(1),
	language: z.string().min(2).default("en-US"),
	heroEyebrow: z.string().min(1),
	heroTitle: z.string().min(1),
	heroDescription: z.string().min(1),
});

const collectionSchema = z.object({
	id: z.string().regex(/^[a-z0-9-]+$/),
	title: z.string().min(1),
	description: z.string().min(1),
	source: z.string().min(1),
	route: z.string().regex(/^[a-z0-9-]+$/),
	defaultViewMode: z.enum(["merged", "series", "both"]).default("both"),
	orderBy: z.enum(["filename", "frontmatter"]).default("filename"),
	typeLabel: z.string().min(1).default("Collection"),
});

const autoBlogSchema = z
	.object({
		site: siteSchema,
		collections: z.array(collectionSchema).min(1),
	})
	.superRefine(({ collections }, ctx) => {
		const ids = new Set<string>();
		const routes = new Set<string>();

		for (const collection of collections) {
			if (ids.has(collection.id)) {
				ctx.addIssue({
					code: "custom",
					message: `Duplicate collection id "${collection.id}"`,
					path: ["collections"],
				});
			}

			if (routes.has(collection.route)) {
				ctx.addIssue({
					code: "custom",
					message: `Duplicate collection route "${collection.route}"`,
					path: ["collections"],
				});
			}

			ids.add(collection.id);
			routes.add(collection.route);
		}
	});

export const siteConfig = autoBlogSchema.parse(rawConfig) as AutoBlogConfig;
