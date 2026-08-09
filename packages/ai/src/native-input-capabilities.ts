import type {
	Model,
	NativeInputCapabilitiesConfig,
	NativeInputCapabilityContext,
	NativeInputCapabilityDefinition,
	NativeInputCapabilityLimits,
	NativeInputCapabilityProvenance,
	NativeInputCapabilityResolver,
	NativeInputTransportSource,
} from "./types.ts";

const OPENAI_FILE_LIMIT_BYTES = 50 * 1024 * 1024;
const ANTHROPIC_REQUEST_LIMIT_BYTES = 32 * 1024 * 1024;
const ANTHROPIC_FILE_LIMIT_BYTES = 500 * 1024 * 1024;
const GEMINI_INLINE_LIMIT_BYTES = 50 * 1024 * 1024;
const GEMINI_MEDIA_INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
const OFFICIAL_CAPABILITIES_VERIFIED_AT = "2026-08-07";

const OPENAI_INPUT_FILE_MEDIA_TYPES = [
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/msword",
	"application/rtf",
	"text/rtf",
	"application/vnd.oasis.opendocument.text",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-excel",
	"text/csv",
	"application/csv",
	"text/tsv",
	"text/plain",
	"text/markdown",
	"text/html",
	"text/xml",
	"application/json",
	"application/javascript",
	"application/typescript",
	"text/javascript",
	"text/css",
	"text/x-python",
	"text/x-typescript",
	"text/x-rust",
	"text/x-go",
	"text/x-java",
	"text/x-c",
	"text/x-c++",
	"text/x-sh",
	"text/x-yaml",
	"application/yaml",
	"application/toml",
] as const;

const GEMINI_DOCUMENT_MEDIA_TYPES = [
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/html",
	"text/css",
	"text/csv",
	"text/xml",
	"application/json",
] as const;

const GEMINI_AUDIO_MEDIA_TYPES = [
	"audio/wav",
	"audio/mpeg",
	"audio/mp3",
	"audio/aiff",
	"audio/aac",
	"audio/ogg",
	"audio/flac",
	"audio/mp4",
] as const;

const GEMINI_VIDEO_MEDIA_TYPES = [
	"video/mp4",
	"video/mpeg",
	"video/quicktime",
	"video/avi",
	"video/x-flv",
	"video/x-ms-wmv",
	"video/webm",
	"video/3gpp",
] as const;

type CapabilityModel = Pick<
	Model<string>,
	"api" | "baseUrl" | "id" | "nativeAttachments" | "nativeInputs" | "provider"
>;

export interface ResolvedNativeInputCapability {
	supported: boolean;
	mediaType: string;
	source?: NativeInputTransportSource;
	capabilityId?: string;
	wireKind?: string;
	sources?: NativeInputTransportSource[];
	wireKinds?: Partial<Record<NativeInputTransportSource, string>>;
	limits?: NativeInputCapabilityLimits;
	requiredHeaders?: Record<string, string>;
	options?: Record<string, unknown>;
	provenance?: NativeInputCapabilityProvenance;
	verifiedAt?: string;
	endpointProfile?: string;
	resolverId?: string;
	reason?: string;
}

export interface ResolvedNativeInputCapabilityManifest {
	endpointProfile: string;
	resolverId: string;
	capabilities: NativeInputCapabilityDefinition[];
}

interface ResolvedManifest {
	manifest: NativeInputCapabilitiesConfig;
	resolverId: string;
}

const registeredResolvers = new Map<string, NativeInputCapabilityResolver>();

function contextFor(model: CapabilityModel): NativeInputCapabilityContext {
	return {
		provider: model.provider,
		api: model.api,
		modelId: model.id,
		baseUrl: model.baseUrl,
	};
}

function hostname(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function pdfCapability(
	id: string,
	sources: NativeInputTransportSource[],
	wireKinds: Partial<Record<NativeInputTransportSource, string>>,
	limits: NativeInputCapabilityLimits,
	extra: Partial<NativeInputCapabilityDefinition> = {},
): NativeInputCapabilityDefinition {
	return {
		id,
		supported: true,
		mediaTypes: ["application/pdf"],
		sources,
		wireKinds,
		limits,
		provenance: "official-default",
		verifiedAt: OFFICIAL_CAPABILITIES_VERIFIED_AT,
		...extra,
	};
}

function nativeCapability(
	id: string,
	mediaTypes: readonly string[],
	sources: NativeInputTransportSource[],
	wireKinds: Partial<Record<NativeInputTransportSource, string>>,
	limits: NativeInputCapabilityLimits,
	extra: Partial<NativeInputCapabilityDefinition> = {},
): NativeInputCapabilityDefinition {
	return {
		id,
		supported: true,
		mediaTypes: [...mediaTypes],
		sources,
		wireKinds,
		limits,
		provenance: "official-default",
		verifiedAt: OFFICIAL_CAPABILITIES_VERIFIED_AT,
		...extra,
	};
}

const builtInResolvers: NativeInputCapabilityResolver[] = [
	{
		id: "openai-audio-chat",
		matches: (context) =>
			context.provider === "openai" &&
			context.api === "openai-completions" &&
			hostname(context.baseUrl) === "api.openai.com",
		resolve: () => ({
			profile: "openai-audio-chat",
			capabilities: [
				nativeCapability(
					"openai-chat-input-audio",
					["audio/wav", "audio/mpeg"],
					["inline"],
					{ inline: "input_audio" },
					{},
					{ modelAllowList: ["gpt-audio*", "gpt-4o-audio-preview*"] },
				),
			],
		}),
	},
	{
		id: "openai-official",
		matches: (context) =>
			context.provider === "openai" &&
			context.api === "openai-responses" &&
			hostname(context.baseUrl) === "api.openai.com",
		resolve: () => ({
			profile: "openai-official",
			capabilities: [
				nativeCapability(
					"openai-responses-input-file",
					OPENAI_INPUT_FILE_MEDIA_TYPES,
					["inline", "url", "provider-file"],
					{ inline: "input_file", url: "input_file", "provider-file": "input_file" },
					{ maximumBytes: OPENAI_FILE_LIMIT_BYTES, maximumRequestBytes: OPENAI_FILE_LIMIT_BYTES },
				),
			],
		}),
	},
	{
		id: "azure-openai-official",
		matches: (context) => {
			const host = hostname(context.baseUrl);
			return (
				context.provider === "azure-openai-responses" &&
				context.api === "azure-openai-responses" &&
				Boolean(
					host?.endsWith(".openai.azure.com") ||
						host?.endsWith(".cognitiveservices.azure.com") ||
						host?.endsWith(".ai.azure.com"),
				)
			);
		},
		resolve: () => ({
			profile: "azure-openai-official",
			capabilities: [
				nativeCapability(
					"azure-openai-responses-input-file",
					OPENAI_INPUT_FILE_MEDIA_TYPES,
					["inline", "url", "provider-file"],
					{ inline: "input_file", url: "input_file", "provider-file": "input_file" },
					{ maximumBytes: OPENAI_FILE_LIMIT_BYTES, maximumRequestBytes: OPENAI_FILE_LIMIT_BYTES },
				),
			],
		}),
	},
	{
		id: "anthropic-official",
		matches: (context) =>
			context.provider === "anthropic" &&
			context.api === "anthropic-messages" &&
			hostname(context.baseUrl) === "api.anthropic.com",
		resolve: () => ({
			profile: "anthropic-official",
			capabilities: [
				pdfCapability(
					"anthropic-document-pdf",
					["inline", "url"],
					{ inline: "document", url: "document" },
					{
						maximumBytes: ANTHROPIC_REQUEST_LIMIT_BYTES,
						maximumRequestBytes: ANTHROPIC_REQUEST_LIMIT_BYTES,
					},
				),
				nativeCapability(
					"anthropic-text-document",
					["text/plain"],
					["inline"],
					{ inline: "document" },
					{
						maximumBytes: ANTHROPIC_REQUEST_LIMIT_BYTES,
						maximumRequestBytes: ANTHROPIC_REQUEST_LIMIT_BYTES,
					},
				),
				nativeCapability(
					"anthropic-files-text-document",
					["text/plain"],
					["provider-file"],
					{ "provider-file": "document" },
					{ maximumBytes: ANTHROPIC_FILE_LIMIT_BYTES },
					{ requiredHeaders: { "anthropic-beta": "files-api-2025-04-14" } },
				),
				pdfCapability(
					"anthropic-files-pdf",
					["provider-file"],
					{ "provider-file": "document" },
					{ maximumBytes: ANTHROPIC_FILE_LIMIT_BYTES },
					{ requiredHeaders: { "anthropic-beta": "files-api-2025-04-14" } },
				),
			],
		}),
	},
	{
		id: "gemini-developer-api",
		matches: (context) =>
			context.provider === "google" &&
			context.api === "google-generative-ai" &&
			hostname(context.baseUrl) === "generativelanguage.googleapis.com",
		resolve: (context) => ({
			profile: "gemini-developer-api",
			capabilities: [
				pdfCapability(
					"gemini-inline-pdf",
					["inline"],
					{ inline: "inlineData" },
					{ maximumBytes: GEMINI_INLINE_LIMIT_BYTES },
				),
				pdfCapability(
					"gemini-url-pdf",
					["url"],
					{ url: "fileData" },
					{},
					{
						supported: !/^gemini-2\.0(?:-|$)/.test(context.modelId),
						reason: /^gemini-2\.0(?:-|$)/.test(context.modelId)
							? `${context.modelId} does not support remote PDF URLs`
							: undefined,
					},
				),
				pdfCapability("gemini-files-pdf", ["provider-file"], { "provider-file": "fileData" }, {}),
				pdfCapability("gemini-cloud-pdf", ["cloud-uri"], { "cloud-uri": "fileData" }, {}),
				nativeCapability(
					"gemini-inline-documents",
					GEMINI_DOCUMENT_MEDIA_TYPES.filter((mediaType) => mediaType !== "application/pdf"),
					["inline"],
					{ inline: "inlineData" },
					{ maximumBytes: GEMINI_INLINE_LIMIT_BYTES },
				),
				nativeCapability(
					"gemini-files-documents",
					GEMINI_DOCUMENT_MEDIA_TYPES.filter((mediaType) => mediaType !== "application/pdf"),
					["provider-file", "cloud-uri"],
					{ "provider-file": "fileData", "cloud-uri": "fileData" },
					{},
				),
				nativeCapability(
					"gemini-inline-media",
					[...GEMINI_AUDIO_MEDIA_TYPES, ...GEMINI_VIDEO_MEDIA_TYPES],
					["inline"],
					{ inline: "inlineData" },
					{ maximumBytes: GEMINI_MEDIA_INLINE_LIMIT_BYTES },
				),
				nativeCapability(
					"gemini-files-media",
					[...GEMINI_AUDIO_MEDIA_TYPES, ...GEMINI_VIDEO_MEDIA_TYPES],
					["provider-file", "cloud-uri"],
					{ "provider-file": "fileData", "cloud-uri": "fileData" },
					{},
				),
			],
		}),
	},
	{
		id: "vertex-official",
		matches: (context) =>
			context.provider === "google-vertex" &&
			context.api === "google-vertex" &&
			hostname(context.baseUrl)?.endsWith(".aiplatform.googleapis.com") === true,
		resolve: () => ({
			profile: "vertex-official",
			capabilities: [
				pdfCapability(
					"vertex-inline-pdf",
					["inline"],
					{ inline: "inlineData" },
					{ maximumBytes: GEMINI_INLINE_LIMIT_BYTES },
				),
				pdfCapability("vertex-cloud-pdf", ["cloud-uri"], { "cloud-uri": "fileData" }, {}),
				nativeCapability(
					"vertex-native-documents",
					GEMINI_DOCUMENT_MEDIA_TYPES.filter((mediaType) => mediaType !== "application/pdf"),
					["inline", "cloud-uri"],
					{ inline: "inlineData", "cloud-uri": "fileData" },
					{ maximumBytes: GEMINI_INLINE_LIMIT_BYTES },
				),
				nativeCapability(
					"vertex-native-media",
					[...GEMINI_AUDIO_MEDIA_TYPES, ...GEMINI_VIDEO_MEDIA_TYPES],
					["inline", "cloud-uri"],
					{ inline: "inlineData", "cloud-uri": "fileData" },
					{ maximumBytes: GEMINI_MEDIA_INLINE_LIMIT_BYTES },
				),
			],
		}),
	},
];

function methodForApi(api: string, source: NativeInputTransportSource): string | undefined {
	if (api === "openai-responses" || api === "azure-openai-responses") return "input_file";
	if (api === "anthropic-messages") return "document";
	if (api === "google-generative-ai" || api === "google-vertex") {
		return source === "inline" ? "inlineData" : "fileData";
	}
	return undefined;
}

function legacyManifest(model: CapabilityModel): NativeInputCapabilitiesConfig | undefined {
	const configured = model.nativeAttachments?.pdf;
	if (!configured) return undefined;
	const sources = configured.sources ?? ["inline"];
	const wireKinds = Object.fromEntries(
		sources.flatMap((source) => {
			const method = methodForApi(model.api, source);
			return method ? [[source, method]] : [];
		}),
	) as Partial<Record<NativeInputTransportSource, string>>;
	return {
		profile: "configured-native-attachments",
		capabilities: [
			{
				id: "legacy-pdf",
				supported: configured.supported && Object.keys(wireKinds).length > 0,
				mediaTypes: ["application/pdf"],
				sources,
				wireKinds,
				limits: {
					maximumBytes: configured.maximumInlineBytes,
					maximumRequestBytes: configured.maximumRequestBytes,
				},
				provenance: "configured",
				reason: !configured.supported
					? "disabled by model configuration"
					: Object.keys(wireKinds).length === 0
						? `${model.api} has no native input lowering implementation`
						: undefined,
			},
		],
	};
}

function manifestFor(model: CapabilityModel): ResolvedManifest | undefined {
	if (model.nativeInputs) return { manifest: model.nativeInputs, resolverId: "model-config" };
	const legacy = legacyManifest(model);
	if (legacy) return { manifest: legacy, resolverId: "legacy-model-config" };

	const context = contextFor(model);
	const customResolvers = [...registeredResolvers.values()].reverse();
	const resolver =
		customResolvers.find((candidate) => candidate.matches(context)) ??
		builtInResolvers.find((candidate) => candidate.matches(context));
	return resolver ? { manifest: resolver.resolve(context), resolverId: resolver.id } : undefined;
}

function patternMatches(value: string, pattern: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

function supportsModel(capability: NativeInputCapabilityDefinition, modelId: string): boolean {
	if (capability.modelAllowList && !capability.modelAllowList.some((pattern) => patternMatches(modelId, pattern))) {
		return false;
	}
	return !capability.modelDenyList?.some((pattern) => patternMatches(modelId, pattern));
}

function matchingCapabilities(
	model: CapabilityModel,
	mediaType?: string,
): { capabilities: NativeInputCapabilityDefinition[]; manifest?: ResolvedManifest } {
	const manifest = manifestFor(model);
	if (!manifest) return { capabilities: [] };
	return {
		manifest,
		capabilities: manifest.manifest.capabilities.filter(
			(capability) =>
				(!mediaType || capability.mediaTypes.includes(mediaType)) && supportsModel(capability, model.id),
		),
	};
}

export function registerNativeInputCapabilityResolver(resolver: NativeInputCapabilityResolver): () => void {
	if (registeredResolvers.has(resolver.id)) {
		throw new Error(`Native input capability resolver already registered: ${resolver.id}`);
	}
	registeredResolvers.set(resolver.id, resolver);
	return () => {
		if (registeredResolvers.get(resolver.id) === resolver) registeredResolvers.delete(resolver.id);
	};
}

export function getNativeInputCapabilities(model: CapabilityModel): NativeInputCapabilityDefinition[] {
	return cloneCapabilities(matchingCapabilities(model).capabilities);
}

function cloneCapabilities(capabilities: NativeInputCapabilityDefinition[]): NativeInputCapabilityDefinition[] {
	return capabilities.map((capability) => ({
		...capability,
		mediaTypes: [...capability.mediaTypes],
		sources: [...capability.sources],
		wireKinds: { ...capability.wireKinds },
		...(capability.limits ? { limits: { ...capability.limits } } : {}),
		...(capability.requiredHeaders ? { requiredHeaders: { ...capability.requiredHeaders } } : {}),
		...(capability.options ? { options: { ...capability.options } } : {}),
	}));
}

export function getNativeInputCapabilityManifest(
	model: CapabilityModel,
): ResolvedNativeInputCapabilityManifest | undefined {
	const { capabilities, manifest } = matchingCapabilities(model);
	if (!manifest) return undefined;
	return {
		endpointProfile: manifest.manifest.profile,
		resolverId: manifest.resolverId,
		capabilities: cloneCapabilities(capabilities),
	};
}

export function resolveNativeInputCapability(
	model: CapabilityModel,
	mediaType: string,
	source?: NativeInputTransportSource,
): ResolvedNativeInputCapability {
	const { capabilities, manifest } = matchingCapabilities(model, mediaType);
	if (!manifest) {
		return {
			supported: false,
			mediaType,
			...(source ? { source } : {}),
			reason:
				"custom endpoints require nativeAttachments.pdf.supported opt-in or explicit native input capability opt-in",
		};
	}

	const matchingSource = source
		? capabilities.find((capability) => capability.sources.includes(source))
		: (capabilities.find((capability) => capability.supported) ?? capabilities[0]);
	if (!matchingSource) {
		const enabledMediaTypes = [
			...new Set(
				manifest.manifest.capabilities
					.filter((capability) => capability.supported && supportsModel(capability, model.id))
					.flatMap((capability) => capability.mediaTypes),
			),
		];
		const undeclaredMediaReason =
			enabledMediaTypes.length === 1
				? `only ${enabledMediaTypes[0]} is enabled`
				: enabledMediaTypes.length > 1
					? `enabled media types are ${enabledMediaTypes.join(", ")}`
					: `${mediaType} is not declared for model ${model.id}`;
		const reason =
			manifest.resolverId === "legacy-model-config" && source
				? `${source} sources are disabled by model configuration`
				: capabilities.length === 0
					? undeclaredMediaReason
					: `${source ?? "requested"} source is not declared by endpoint profile ${manifest.manifest.profile}`;
		return {
			supported: false,
			mediaType,
			...(source ? { source } : {}),
			endpointProfile: manifest.manifest.profile,
			resolverId: manifest.resolverId,
			reason,
		};
	}

	const supportedCapabilities = capabilities.filter((capability) => capability.supported);
	const sources = [...new Set(supportedCapabilities.flatMap((capability) => capability.sources))];
	const wireKinds = Object.assign({}, ...supportedCapabilities.map((capability) => capability.wireKinds));
	const selectedSource = source ?? matchingSource.sources.find((candidate) => matchingSource.wireKinds[candidate]);
	const wireKind = selectedSource ? matchingSource.wireKinds[selectedSource] : undefined;
	return {
		supported: matchingSource.supported && wireKind !== undefined,
		mediaType,
		...(source ? { source } : {}),
		capabilityId: matchingSource.id,
		wireKind,
		sources,
		wireKinds,
		...(matchingSource.limits ? { limits: { ...matchingSource.limits } } : {}),
		...(matchingSource.requiredHeaders ? { requiredHeaders: { ...matchingSource.requiredHeaders } } : {}),
		...(matchingSource.options ? { options: { ...matchingSource.options } } : {}),
		provenance: matchingSource.provenance,
		...(matchingSource.verifiedAt ? { verifiedAt: matchingSource.verifiedAt } : {}),
		endpointProfile: manifest.manifest.profile,
		resolverId: manifest.resolverId,
		...(matchingSource.reason
			? { reason: matchingSource.reason }
			: matchingSource.supported && wireKind === undefined
				? { reason: `${source ?? "requested"} source has no declared wire kind` }
				: {}),
	};
}
