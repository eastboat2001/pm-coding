import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { SkillLoadDetails, SkillResourceDetails, SkillSummary } from "../src/skill-tools/schemas.js";
import { createServerSkillTools, type SkillToolRequest } from "../src/skill-tools/tools.js";

vi.mock("../src/skill-tools/renderers.js", () => ({ registerSkillToolRenderers: vi.fn() }));

function summary(name: string, allowImplicitInvocation = true): SkillSummary {
	return {
		name,
		description: `Use when ${name} is required.`,
		location: `skill://${name}/SKILL.md`,
		allowImplicitInvocation,
	};
}

function loaded(name: string, resources: SkillLoadDetails["resources"] = []): SkillLoadDetails {
	return {
		...summary(name),
		content: `Instructions for ${name}.`,
		resources,
	};
}

function toolNamed(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool;
}

describe("server skill tools", () => {
	it("exposes no tools for an empty runtime snapshot", () => {
		const request = vi.fn<SkillToolRequest>();

		expect(createServerSkillTools({ skills: [], request })).toEqual([]);
		expect(request).not.toHaveBeenCalled();
	});

	it("exposes load only for implicit skills and lists the exact allowlist", () => {
		const request = vi.fn<SkillToolRequest>();
		const tools = createServerSkillTools({
			skills: [summary("implicit-skill"), summary("explicit-only", false)],
			request,
		});

		expect(tools.map((tool) => tool.name)).toEqual(["skill_load", "skill_resource"]);
		expect(toolNamed(tools, "skill_load").description).toContain("implicit-skill");
		expect(toolNamed(tools, "skill_load").description).not.toContain("explicit-only");
		expect(toolNamed(tools, "skill_resource").description).toContain("Do not call this tool when resources are none");
		expect(toolNamed(tools, "skill_resource").description).toContain("location is not a resource path");
	});

	it("rejects unknown skill names locally without a request", async () => {
		const request = vi.fn<SkillToolRequest>();
		const loadTool = toolNamed(createServerSkillTools({ skills: [summary("known-skill")], request }), "skill_load");

		await expect(loadTool.execute("call-1", { name: "invented-skill" })).rejects.toThrow(/not authorized/i);
		expect(request).not.toHaveBeenCalled();
	});

	it("loads an allowed skill once and reuses the successful activation", async () => {
		const request = vi.fn<SkillToolRequest>().mockResolvedValue(loaded("known-skill"));
		const loadTool = toolNamed(createServerSkillTools({ skills: [summary("known-skill")], request }), "skill_load");

		const first = await loadTool.execute("call-1", { name: "known-skill" });
		const second = await loadTool.execute("call-2", { name: "known-skill" });

		expect(first.details).toEqual(second.details);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith("/load", expect.objectContaining({ body: { name: "known-skill" } }));
	});

	it("allows only activated and exactly listed resources and caches successful reads", async () => {
		const loadResult = loaded("known-skill", [{ path: "references/guide.md", size: 20 }]);
		const resourceResult: SkillResourceDetails = {
			name: "known-skill",
			path: "references/guide.md",
			content: "Guide content.",
			size: 14,
		};
		const request = vi.fn<SkillToolRequest>(async (path) =>
			path === "/load" ? loadResult : resourceResult,
		);
		const tools = createServerSkillTools({ skills: [summary("known-skill")], request });
		const loadTool = toolNamed(tools, "skill_load");
		const resourceTool = toolNamed(tools, "skill_resource");

		await expect(
			resourceTool.execute("resource-before-load", { name: "known-skill", path: "references/guide.md" }),
		).rejects.toThrow(/not active/i);
		await loadTool.execute("load", { name: "known-skill" });
		await expect(
			resourceTool.execute("unlisted", { name: "known-skill", path: "references/guessed.md" }),
		).rejects.toThrow(/not listed/i);
		await resourceTool.execute("listed-1", { name: "known-skill", path: "references/guide.md" });
		await resourceTool.execute("listed-2", { name: "known-skill", path: "references/guide.md" });

		expect(request).toHaveBeenCalledTimes(2);
	});

	it("exposes resource only for preloaded explicit-only skills", async () => {
		const request = vi.fn<SkillToolRequest>().mockResolvedValue({
			name: "explicit-only",
			path: "references/guide.md",
			content: "Explicit guide.",
			size: 15,
		});
		const tools = createServerSkillTools({
			skills: [summary("explicit-only", false)],
			explicitSkillNames: ["explicit-only"],
			preloadedSkills: [loaded("explicit-only", [{ path: "references/guide.md", size: 15 }])],
			request,
		});

		expect(tools.map((tool) => tool.name)).toEqual(["skill_resource"]);
		await toolNamed(tools, "skill_resource").execute("resource", {
			name: "explicit-only",
			path: "references/guide.md",
		});
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("exposes no resource tool for a preloaded explicit skill without resources", () => {
		const tools = createServerSkillTools({
			skills: [summary("explicit-only", false)],
			explicitSkillNames: ["explicit-only"],
			preloadedSkills: [loaded("explicit-only")],
		});

		expect(tools).toEqual([]);
	});
});
