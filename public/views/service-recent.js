// @ts-check
import van from "../vendor/van-1.6.1.js";
import { parameterValue } from "../lib/parameter-backup.js";
import { serviceChanges } from "../lib/service-client.js";

export function ServiceRecent() {
  return details(
    { class: "layout-accordion service-recent" },
    summary(span({ class: "service-title" }, "Recent changes")),
    div({ class: "layout-accordion-body" }, () => {
      const changes = serviceChanges.val;
      return changes.length
        ? div(
            { class: "layout-stack" },
            changes.map(change =>
              div(
                { class: "layout-compact-stack" },
                span({ class: "label" }, change.parameter.name),
                span(
                  { class: "service-sub" },
                  `${parameterValue(change.parameter, change.previous)} → ${parameterValue(change.parameter, change.value)} · confirmed`
                )
              )
            )
          )
        : span({ class: "service-sub" }, "No changes in this session");
    })
  );
}

const { details, div, span, summary } = van.tags;
