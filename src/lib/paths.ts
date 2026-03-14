const baseUrl = import.meta.env.BASE_URL.endsWith("/")
	? import.meta.env.BASE_URL
	: `${import.meta.env.BASE_URL}/`;

export function withBase(pathname = "") {
	const normalizedPath = pathname.replace(/^\/+/, "");
	return normalizedPath ? `${baseUrl}${normalizedPath}` : baseUrl;
}
