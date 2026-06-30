import { describe, expect, it, vi } from "vitest";
import { createCoalescedRenderScheduler } from "../src/app/render-scheduler.js";

describe("render scheduler", () => {
	it("coalesces multiple requests into one frame render", () => {
		const render = vi.fn();
		const frameCallbacks: Array<() => void> = [];
		const scheduleRender = createCoalescedRenderScheduler(render, (callback) => {
			frameCallbacks.push(callback);
		});

		scheduleRender();
		scheduleRender();
		scheduleRender();

		expect(render).not.toHaveBeenCalled();
		expect(frameCallbacks).toHaveLength(1);

		frameCallbacks[0]?.();

		expect(render).toHaveBeenCalledTimes(1);

		scheduleRender();

		expect(frameCallbacks).toHaveLength(2);
	});
});
