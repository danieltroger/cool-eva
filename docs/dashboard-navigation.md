# Persistent dashboard navigation

The approved sketch uses five bottom tabs, in order: Ride, Range, Charge, Faults, More. Every dashboard destination retains this bar. More has only Settings, Bike and Service in its top switch. The header shows the parent name, one dashboard connection dot, and the applicable top switch. Settings contains setup, repair and reload information; the header no longer offers separate menu, Setup or CAN navigation.

The shell reserves 52 CSS pixels plus the actual top safe area. Top links have 44 px touch targets. Bottom navigation reserves 50 px plus the actual bottom inset. The fixed riding layout check still requires at least 12 px below complete content. The safe areas come from the platform, rather than fixed phone padding in production.

Navigation uses real links and the existing history routes. Ordinary taps update the app without loading another document; modified clicks retain working URLs. Leaving a destination removes both `panel` and `section` from the target URL and clears any pending write confirmation. Back and Forward restore the actual route. Repeated current-view taps do not add history entries.

Ride/Cooling and Range/Cells share the header switch. More opens Settings; Bike groups the existing ride, waypoint and bike information content. Service contains the inline parameter editor, individual backup changes, Service actions, Recent changes and a browsable All signals disclosure. The legacy `#all` address opens that same Service page with All signals expanded. The old panel URLs remain readable; `params.html` redirects to Service.

The handlebar cycle is Ride → Cooling → Range → Charge → Faults → Ride. More and its destinations are parked-bike views: neither handlebar gestures nor automatic charge/range focus interrupts them. Their arrival still consumes automatic focus edges, so returning to a riding view does not replay a queued jump.

`check-persistent-navigation.ts` exercises actual routing state, destination exits, URL restoration, duplicate taps and disarming. The phone-width gate follows More → Bike and expands the waypoint list before measuring the longest refusal row. Browser checks cover both themes and safe-area geometries, the rendered header, real links, browser history, destination exits and handlebar exclusions.

## Earlier sheet measurement findings

The removed menu sheet was fixed to the viewport. Its subtree did not contribute to the document's scrollable overflow, and its border box always matched the viewport even when children overflowed. Consequently, `body.scrollWidth` alone could not witness this surface: the check measured the sheet's own content width and each waypoint row's right edge. A hidden sheet still had full layout boxes, so opening it had to be asserted separately. These measurements now follow the visible Bike destination and assert that its top switch is selected before inspecting the list.

A synthetic unbreakable-token probe remains necessary: coordinate pairs and ordinary refusal sentences wrap at spaces, so real rows cannot falsify `overflow-wrap: anywhere`. In the earlier sheet, removing that rule produced 969 px of content inside a 390 px container while the row's own block width stayed 372 px. The check therefore measures the containing surface, then removes the probe. The expanded list is required because the longest refusal lies outside its six-row preview.

The earlier header policy and CAN liveness findings remain in [dashboard-header.md](dashboard-header.md) as historical rationale. The persistent shell's connection dot describes dashboard liveness only; CAN adapter state remains in the existing settings content until its cleanup PR.
