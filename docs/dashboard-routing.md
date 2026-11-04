# Dashboard view routing

The bottom destinations retain their original addresses, including #hypermile for Range. Cooling adds #ride/cooling; a current-parent tap and an automatic parent arrival restore the overview as real disarming navigations. The six-stop handlebar cycle is the exported view table. New subviews join the table when their actual content lands.

Browser history is the only history stack. Explicit arrivals start at the top; URL restoration disarms separately because Back/Forward and hash edits bypass the explicit navigation function. Menu pages retain their gesture and automatic-move exclusions and return to the actual subview label.

| Screen | Address and kind | Handlebar gesture | Automatic arrivals |
| --- | --- | --- | --- |
| Ride / Cooling | `#ride` / `#ride/cooling`, riding views | Ride → Cooling → Range | Restore the requested parent overview |
| Range / Charge / All / Faults | Existing `#hypermile` / `#charge` / `#all` / `#faults` riding views | Continue the six-stop cycle | Charge start → Charge; charge exit while on Charge → Ride; near-empty → Range |
| Bike information / Session | Existing `panel=bike-information` / `panel=session` menu pages | Excluded; return to the originating view | Excluded; edges are consumed without a queued jump on return |
| Settings / Advanced service | Existing `panel=settings` / `panel=advanced-service` menu pages | Excluded | Excluded |

Cells, Charge details, Battery & cooling and the full Fault report are added with their content in later changes. Cells and Charge details are URL subviews whose next handlebar stop is the next parent overview; a charge start restores the Charge overview even from an already-selected Charge detail. Battery & cooling is a menu page with the same exclusions as Session. The Fault report is a URL subview whose next stop is Ride. Their Back actions retain their actual origins.

The original canonicalisation constraints are preserved below:

What to do about a fragment: the tab it lands on, what the URL should be rewritten to — null when it already says the right thing — and whether the fragment named that tab or merely fell back to it. The three are independent.

Pure, so the rule can be checked without a browser; the same split as headroomMvWith() in lib/derive.js, and for the same reason.

Rewriting only when it would CHANGE something is the part worth not undoing: Back through ten tabs must not spend ten replaceState calls out of Safari's bucket. Why rewrite at all, and why no caller pushes: docs/dashboard-decisions.md §Routing.
