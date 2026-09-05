import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanMarkdown } from "../PlanReviewCard";

const PLAN = `# Plan

## Shortlist
| # | Dự án | Issue | Nhãn |
|---|---|---|---|
| **A** | storybookjs/storybook | [#36143](https://github.com/storybookjs/storybook/issues/36143) \`split('.')\` | bug, cli |
| B | directus/directus | #28185 | Bug |

- item one
`;

describe("PlanMarkdown", () => {
  it("renders GFM tables inside a horizontally scrollable, bordered container", () => {
    const html = renderToStaticMarkup(<PlanMarkdown markdown={PLAN} />);
    // The repo has no @tailwindcss/typography, so `prose` is a no-op and must
    // not be relied on for layout.
    expect(html).not.toContain("prose");
    // Wide tables scroll inside their own box instead of stretching the card.
    expect(html).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/);
    // Cells are bordered and top-aligned so a tall cell doesn't float its
    // neighbours into the middle of a huge row.
    expect(html).toMatch(/<th class="[^"]*border[^"]*"/);
    expect(html).toMatch(/<td class="[^"]*border[^"]*align-top[^"]*"/);
    // Content survives.
    expect(html).toContain("storybookjs/storybook");
    expect(html).toContain('href="https://github.com/storybookjs/storybook/issues/36143"');
  });

  it("gives headings and lists explicit spacing/markers", () => {
    const html = renderToStaticMarkup(<PlanMarkdown markdown={PLAN} />);
    expect(html).toMatch(/<h1 class="[^"]*font-semibold/);
    expect(html).toMatch(/<h2 class="[^"]*font-semibold/);
    expect(html).toMatch(/<ul class="[^"]*list-disc/);
  });
});
