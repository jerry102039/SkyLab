import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiPveMarkdownContent, sanitizeAiPveContent } from "./AiPveChat";

describe("sanitizeAiPveContent", () => {
  it("removes internal model markers from visible messages", () => {
    expect(sanitizeAiPveContent("<think>分析中</think>節點正常<|endoftext|>")).toBe("節點正常");
    expect(sanitizeAiPveContent(null)).toBe("");
  });

  it("renders assistant Markdown instead of showing formatting markers", () => {
    const html = renderToStaticMarkup(
      React.createElement(AiPveMarkdownContent, { content: "**CPU 使用率**\n\n- 85%" }),
    );

    expect(html).toContain("<strong>CPU 使用率</strong>");
    expect(html).toContain("<li>85%</li>");
    expect(html).not.toContain("**CPU 使用率**");
  });

  it("sanitizes raw HTML in assistant Markdown", () => {
    const html = renderToStaticMarkup(
      React.createElement(AiPveMarkdownContent, {
        content: '<script>alert("xss")</script>\n\n**安全**',
      }),
    );

    expect(html).not.toContain("<script");
    expect(html).toContain("<strong>安全</strong>");
  });
});
