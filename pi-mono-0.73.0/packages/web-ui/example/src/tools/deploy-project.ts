import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@mariozechner/pi-ai";
import type { ArtifactsPanel } from "@mariozechner/pi-web-ui";

const deployProjectParamsSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Short project title to use for the deployment name." })),
});

type DeployProjectParams = Static<typeof deployProjectParamsSchema>;

interface DeployProjectContext {
	sessionId?: string;
	title?: string;
}

interface DeployProjectResult {
	projectId: string;
	status: string;
	previewUrl: string;
	deploymentRoot: string;
	serveRoot: string;
	fileCount: number;
	logs?: string[];
}

export function createDeployProjectTool(
	artifactsPanel: ArtifactsPanel,
	getContext: () => DeployProjectContext,
): AgentTool<typeof deployProjectParamsSchema, DeployProjectResult> {
	return {
		label: "Deploy Project",
		name: "deploy_project",
		description:
			"Deploy the current generated artifact files to the configured server directory, install/build the project when package.json exists, and return a public preview URL. Use this after creating the runnable project files.",
		parameters: deployProjectParamsSchema,
		executionMode: "sequential",
		execute: async (_toolCallId: string, args: DeployProjectParams) => {
			const context = getContext();
			if (!context.sessionId) {
				throw new Error("Cannot deploy before the current session has been created.");
			}

			const files = Array.from(artifactsPanel.artifacts.values()).map((artifact) => ({
				filename: artifact.filename,
				content: artifact.content,
			}));
			if (files.length === 0) {
				throw new Error("No generated artifact files are available to deploy.");
			}

			const response = await fetch("/api/pi-projects/deploy", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: context.sessionId,
					title: args.title || context.title || "generated-project",
					files,
				}),
			});
			const result = (await response.json().catch(() => ({}))) as DeployProjectResult & { error?: string };
			if (!response.ok) {
				throw new Error(result.error || `Deployment failed with HTTP ${response.status}`);
			}

			const logs = Array.isArray(result.logs) ? result.logs.join("").trim() : "";
			const text =
				result.status === "running"
					? `Deployment complete.\nPreview URL: ${result.previewUrl}\nProject directory: ${result.deploymentRoot}`
					: `Deployment failed.\nProject directory: ${result.deploymentRoot}\n${logs ? `\nLogs:\n${logs}` : ""}`;

			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	};
}
