# Dashboard view routing

The bottom destinations retain their original addresses, including #hypermile for Range. Cooling adds #ride/cooling; a current-parent tap and an automatic parent arrival restore the overview as real disarming navigations. The six-stop handlebar cycle is RIDING_CYCLE, separate from the complete ROUTES table. New subviews join the table when their actual content lands.

Browser history is the only history stack. Explicit arrivals start at the top; URL restoration disarms separately because Back/Forward and hash edits bypass the explicit navigation function. Menu pages retain their gesture and automatic-move exclusions and return to the actual subview label.

A tab's name is a URL, not just a display label: `/#charge` is what a phone home-screen bookmark holds. Renaming a name in TABS silently breaks those bookmarks even while a freshly opened dashboard still builds, typechecks and works. `scripts/check-tab-routing.ts` therefore pins names by hand rather than deriving its expected URLs from TABS, so changing one is an explicit decision.

The parent and subview states are private and have exactly two writers: explicit navigation in `showView()` (also reached through `showTab()`) moves the screen and URL together; `showTabFromUrl()` follows a URL the browser already moved. Nothing outside the router can set one without the other. This makes screen/URL agreement a property of the module instead of something every caller must remember.

`nextViewAfter()` wraps a name absent from ROUTES to the first view: `findIndex` returns -1 and adding one turns that into zero before the modulo. ViewName prevents that input in checked callers, but the fallback remains the right answer if it ever occurs.

| Screen | Address and kind | Handlebar gesture | Automatic arrivals |
| --- | --- | --- | --- |
| Ride / Cooling | `#ride` / `#ride/cooling`, riding views | Ride → Cooling → Range | Restore the requested parent overview |
| Range / Charge / All / Faults | Existing `#hypermile` / `#charge` / `#all` / `#faults` riding views | Continue the six-stop cycle | Charge start → Charge; charge exit while on Charge → Ride; near-empty → Range |
| Cells | `#hypermile/cells`, scrolling URL subview | Charge overview | Charge start → Charge; near-empty → Range overview |
| Bike information / Session / Battery & cooling | Existing `panel=bike-information` / `panel=session` / `panel=battery-cooling` menu pages | Excluded; return to the originating view | Excluded; edges are consumed without a queued jump on return |
| Settings / Advanced service | Existing `panel=settings` / `panel=advanced-service` menu pages | Excluded | Excluded |

Cells (#hypermile/cells) and the Battery & cooling menu page (panel=battery-cooling) are now implemented; Charge details and the full Fault report follow in later changes. Cells and Charge details are URL subviews whose next handlebar stop is the next parent overview; a charge start restores the Charge overview even from an already-selected Charge detail. Battery & cooling is a menu page with the same exclusions as Session. The Fault report is a URL subview whose next stop is Ride. Their Back actions retain their actual origins.

The original canonicalisation constraints are preserved below:

What to do about a fragment: the tab it lands on, what the URL should be rewritten to — null when it already says the right thing — and whether the fragment named that tab or merely fell back to it. The three are independent.

Pure, so the rule can be checked without a browser; the same split as headroomMvWith() in lib/derive.js, and for the same reason.

Rewriting only when it would CHANGE something is the part worth not undoing: Back through ten tabs must not spend ten replaceState calls out of Safari's bucket. Why rewrite at all, and why no caller pushes: docs/dashboard-decisions.md §Routing.

Cells returns to its actual browser-history origin, including Battery & cooling after reload. Its in-view Back control exists only for an explicit menu origin; ordinary entries use the Range sub-tab. Its next gesture advances from the Range parent to Charge. Native browser history retains scroll positions; the real-preview sequence covers scrolling Cells, parent reset, Back, Forward and reload.

Charge adds #charge/pack-cooling and #charge/controls. Both advance to All through either gesture. A current-parent tap or actual charge-start restores the Charge overview and disarms, including from an already-selected Charge parent. Charge exit from either detail returns to Ride; link loss is not charge exit. Controls keeps the original gated handlers and dwell.
