import type { ParameterTableDelta } from "./table-catalog.ts";

// GENERATED FILE — do not edit by hand. Regenerate with:
//
//     node --experimental-strip-types scripts/extract-vcu-tables.ts /path/to/service-tool.exe
//     npx prettier --write src/vcu/table-catalog.data.ts
//
// Energica's VCU parameter tables, one entry per `TABLE_TYPE` the manufacturer's
// service tool can select, each stored as a DELTA against `params.ecf` (which is table
// 16406 — see ./param-file.ts). ./table-catalog.ts rebuilds the full table from a delta
// and checks the result against the fingerprint recorded here, which was taken from
// Energica's own bundle rather than from the delta.
//
// Delta format, one row per line — the same columns as params.ecf, minus the ones that
// cannot differ:
//
//     <index> <NAME>              the id is renamed; signedness unchanged
//     <index> <NAME> <S|U>        renamed and/or the S/U column differs
//     + <index> <NAME> <TYPE> <S|U> <MICRO>   an id params.ecf does not have
//     - <index>                   an id params.ecf has and this table does not
//
// An empty delta means the table is byte-identical to params.ecf.
//
// ⚠️ Adding your own bike's table is a supported thing to do and does not mean editing
// this file by hand — see README.md, "Adding your bike's VCU parameter table".

export const PARAMETER_TABLE_DELTAS: ParameterTableDelta[] = [
  {
    tableType: 4102,
    exportStamp: "201904030933",
    fingerprint: "de5aff84",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
148 DBW_DUMMY_WORD5
149 DBW_DUMMY_WORD6
150 DBW_DUMMY_WORD7
151 DBW_DUMMY_WORD8
152 DBW_DUMMY_WORD9
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
222 LIMP_DUMMY_WORD8 S
251 LIGHTS_DUMMY_WORD3
252 LIGHTS_DUMMY_WORD4
253 SPEED_ODO_DUMMY_WORD1 S
254 SPEED_ODO_DUMMY_WORD2 S
255 SPEED_ODO_DUMMY_WORD3 S
256 SPEED_ODO_DUMMY_WORD4 S
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 EVSE_DUMMY_WORD2
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 4104,
    exportStamp: "201904030934",
    fingerprint: "97a36ee9",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
152 RWSS_CAL0_1
153 RWSS_CAL2_3
154 FWSS_CAL0_1
155 FWSS_CAL2_3
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 EVSE_DUMMY_WORD2
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 4106,
    exportStamp: "201904030934",
    fingerprint: "97a36ee9",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
152 RWSS_CAL0_1
153 RWSS_CAL2_3
154 FWSS_CAL0_1
155 FWSS_CAL2_3
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 EVSE_DUMMY_WORD2
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 4112,
    exportStamp: "201904161554",
    fingerprint: "3ae1f7f4",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
147 DBW_CONFIG S
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 4114,
    exportStamp: "201912121751",
    fingerprint: "94d568ef",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 CELL_COUNT
18 INACTIVITY_TIMEOUT
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
266 CELL_COUNT
267 CELL_TYPE
`,
  },
  {
    tableType: 4115,
    exportStamp: "service-tool-analysis",
    fingerprint: "f591017d",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 CELL_COUNT_C
19 VSM_DUMMY_WORD5
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
266 CELL_COUNT_S
267 CELL_TYPE
`,
  },
  {
    tableType: 4117,
    exportStamp: "202202241008",
    fingerprint: "5fc76505",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 CELL_COUNT_C
19 VSM_DUMMY_WORD5
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
266 CELL_COUNT_S
267 CELL_TYPE
`,
  },
  {
    tableType: 4118,
    exportStamp: "202310160851",
    fingerprint: "d0d027dd",
    delta: ``,
  },
  {
    tableType: 4119,
    exportStamp: "202310160850",
    fingerprint: "5757d064",
    delta: `
249 R_BRAKE_POPUP
`,
  },
  {
    tableType: 8199,
    exportStamp: "201904030935",
    fingerprint: "2bada598",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
150 DBW_DUMMY_WORD7
151 DBW_DUMMY_WORD8
152 DBW_DUMMY_WORD9
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
222 LIMP_DUMMY_WORD8 S
253 SPEED_ODO_DUMMY_WORD1 S
254 SPEED_ODO_DUMMY_WORD2 S
255 SPEED_ODO_DUMMY_WORD3 S
256 SPEED_ODO_DUMMY_WORD4 S
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 EVSE_DUMMY_WORD2
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 8208,
    exportStamp: "201904161548",
    fingerprint: "ab1495e3",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
222 LIMP_DUMMY_WORD8 S
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 12293,
    exportStamp: "201904030935",
    fingerprint: "de5aff84",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
148 DBW_DUMMY_WORD5
149 DBW_DUMMY_WORD6
150 DBW_DUMMY_WORD7
151 DBW_DUMMY_WORD8
152 DBW_DUMMY_WORD9
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
222 LIMP_DUMMY_WORD8 S
251 LIGHTS_DUMMY_WORD3
252 LIGHTS_DUMMY_WORD4
253 SPEED_ODO_DUMMY_WORD1 S
254 SPEED_ODO_DUMMY_WORD2 S
255 SPEED_ODO_DUMMY_WORD3 S
256 SPEED_ODO_DUMMY_WORD4 S
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 EVSE_DUMMY_WORD2
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 16391,
    exportStamp: "201904030936",
    fingerprint: "2bada598",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
150 DBW_DUMMY_WORD7
151 DBW_DUMMY_WORD8
152 DBW_DUMMY_WORD9
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
222 LIMP_DUMMY_WORD8 S
253 SPEED_ODO_DUMMY_WORD1 S
254 SPEED_ODO_DUMMY_WORD2 S
255 SPEED_ODO_DUMMY_WORD3 S
256 SPEED_ODO_DUMMY_WORD4 S
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 EVSE_DUMMY_WORD2
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 16402,
    exportStamp: "201912130945",
    fingerprint: "545fc999",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 CELL_COUNT
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
266 CELL_COUNT
267 CELL_TYPE
`,
  },
  {
    tableType: 16406,
    exportStamp: "202212060931",
    fingerprint: "d0d027dd",
    delta: ``,
  },
  {
    tableType: 16407,
    exportStamp: "202310160853",
    fingerprint: "5757d064",
    delta: `
249 R_BRAKE_POPUP
`,
  },
  {
    tableType: 20487,
    exportStamp: "201904030936",
    fingerprint: "065d3d13",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
150 DBW_DUMMY_WORD7
151 DBW_DUMMY_WORD8
152 DBW_DUMMY_WORD9
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
249 EE_LIGHTS_DUMMY_WORD1
253 SPEED_ODO_DUMMY_WORD1 S
254 SPEED_ODO_DUMMY_WORD2 S
255 SPEED_ODO_DUMMY_WORD3 S
256 SPEED_ODO_DUMMY_WORD4 S
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 EVSE_DUMMY_WORD2
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 20490,
    exportStamp: "201904030937",
    fingerprint: "099018ba",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
152 RWSS_CAL0_1
153 RWSS_CAL2_3
154 FWSS_CAL0_1
155 FWSS_CAL2_3
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
249 EE_LIGHTS_DUMMY_WORD1
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 20496,
    exportStamp: "201904030938",
    fingerprint: "099018ba",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
152 RWSS_CAL0_1
153 RWSS_CAL2_3
154 FWSS_CAL0_1
155 FWSS_CAL2_3
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
249 EE_LIGHTS_DUMMY_WORD1
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 20498,
    exportStamp: "201910011639",
    fingerprint: "cfbf2936",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 CELL_COUNT
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
249 EE_LIGHTS_DUMMY_WORD1
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
266 CELL_COUNT
267 CELL_TYPE
`,
  },
  {
    tableType: 20502,
    exportStamp: "202212051656",
    fingerprint: "9548d401",
    delta: `
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
`,
  },
  {
    tableType: 20503,
    exportStamp: "202310160855",
    fingerprint: "2395ce38",
    delta: `
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
249 R_BRAKE_POPUP
`,
  },
  {
    tableType: 24597,
    exportStamp: "202202241009",
    fingerprint: "86dbe3d4",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 CELL_COUNT_C
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
266 CELL_COUNT_S
267 CELL_TYPE
`,
  },
  {
    tableType: 24598,
    exportStamp: "202203291245",
    fingerprint: "a2ec773f",
    delta: `
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
`,
  },
  {
    tableType: 24599,
    exportStamp: "202310160856",
    fingerprint: "4c60b6cc",
    delta: `
100 TARGET_AC_DELTA
101 TARGET_DC_DELTA
249 R_BRAKE_POPUP
266 EE_FW_RAD_0_1 U
267 EE_FW_RAD_2_3 U
268 EE_RW_RAD_1_2 U
269 EE_RW_RAD_2_3 U
270 FIRMWARE_BUNDLE_H U
271 FIRMWARE_BUNDLE_L U
272 FIRMWARE_UPDATE_DATE_H U
273 FIRMWARE_UPDATE_DATE_L U
`,
  },
  {
    tableType: 61450,
    exportStamp: "201904030938",
    fingerprint: "099018ba",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 VSM_DUMMY_WORD3
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
51 MAP0_CURRENT
53 MAP1_CURRENT
55 MAP2_CURRENT
57 MAP3_CURRENT
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_1 U
96 ThrottleNeutralPosition_2 U
97 ThrottleNeutralPosition_3 U
98 ThrottleNeutralPosition_4 U
99 ThrottleNeutralPosition_5 U
100 ThrottleNeutralPosition_6
101 ThrottleNeutralPosition_7
102 ThrottleNeutralPosition_8
103 ThrottleNeutralPosition_9
104 ThrottleNeutralPosition_10
105 ThrottleNeutralPosition_11
106 ThrottleNeutralPosition_12
107 ThrottleNeutralPosition_13
108 ThrottleNeutralPosition_14
109 ThrottleNeutralPosition_15
110 ThrottleNeutralPosition_16
111 ThrottleNeutralPosition_17
112 ThrottleNeutralPosition_18
113 ThrottleNeutralPosition_19
114 ThrottleNeutralPosition_20
115 ThrottleNeutralPosition_21
116 ThrottleNeutralPosition_22
117 ThrottleNeutralPosition_23
118 ThrottleNeutralPosition_24
119 ThrottleNeutralPosition_25
152 RWSS_CAL0_1
153 RWSS_CAL2_3
154 FWSS_CAL0_1
155 FWSS_CAL2_3
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
249 EE_LIGHTS_DUMMY_WORD1
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
`,
  },
  {
    tableType: 61451,
    exportStamp: "201905231042",
    fingerprint: "e24d67cf",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 EE_CHRONO_DURATION
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_0_1 U
96 ThrottleNeutralPosition_0_2 U
97 ThrottleNeutralPosition_0_3 U
98 ThrottleNeutralPosition_0_4 U
99 ThrottleNeutralPosition_0_5 U
100 ThrottleNeutralPosition_1_1
101 ThrottleNeutralPosition_1_2
102 ThrottleNeutralPosition_1_3
103 ThrottleNeutralPosition_1_4
104 ThrottleNeutralPosition_1_5
105 ThrottleNeutralPosition_2_1
106 ThrottleNeutralPosition_2_2
107 ThrottleNeutralPosition_2_3
108 ThrottleNeutralPosition_2_4
109 ThrottleNeutralPosition_2_5
110 DBW_DUMMY_WORD21
111 DBW_DUMMY_WORD22
112 DBW_DUMMY_WORD23
113 DBW_DUMMY_WORD24
114 DBW_DUMMY_WORD25
115 DBW_DUMMY_WORD26
116 DBW_DUMMY_WORD27
117 DBW_DUMMY_WORD28
118 DBW_DUMMY_WORD29
119 DBW_DUMMY_WORD30
144 PIT_LIMIT
146 DBW_DUMMY_WORD3
152 DBW_DUMMY_WORD9
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
164 EE_TYRE_CONFIG_1
165 EE_TYRE_CONFIG_2
166 EE_FTYRE1_RADIUS U
167 EE_FTYRE1_C1_C2
168 EE_FTYRE1_C3_C4
169 EE_FTYRE2_RADIUS
170 EE_FTYRE2_C1_C2
171 EE_FTYRE2_C3_C4
172 EE_FTYRE3_RADIUS
173 EE_FTYRE3_C1_C2
174 EE_FTYRE3_C3_C4
175 EE_FTYRE4_RADIUS
176 EE_FTYRE4_C1_C2
177 EE_FTYRE4_C3_C4
178 EE_FTYRE5_RADIUS
179 EE_FTYRE5_C1_C2
180 EE_FTYRE5_C3_C4
181 EE_FTYRE6_RADIUS
182 EE_FTYRE6_C1_C2
183 EE_FTYRE6_C3_C4
184 EE_RTYRE1_RADIUS
185 EE_RTYRE1_C1_C2
186 EE_RTYRE1_C3_C4
187 EE_RTYRE2_RADIUS
188 EE_RTYRE2_C1_C2
189 EE_RTYRE2_C3_C4
190 EE_RTYRE3_RADIUS
191 EE_RTYRE3_C1_C2
192 EE_RTYRE3_C3_C4
193 EE_RTYRE4_RADIUS
194 EE_RTYRE4_C1_C2
195 EE_RTYRE4_C3_C4
196 EE_RTYRE5_RADIUS
197 EE_RTYRE5_C1_C2
198 EE_RTYRE5_C3_C4
199 EE_RTYRE6_RADIUS
200 EE_RTYRE6_C1_C2
201 EE_RTYRE6_C3_C4
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
253 SPEED_ODO_SPEEDSOURCE
254 SPEED_ODO_DUMMY2
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
+ 300 MOTORING_MAP BYTE U A9
`,
  },
  {
    tableType: 61452,
    exportStamp: "201907301047",
    fingerprint: "e24d67cf",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 EE_CHRONO_DURATION
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_0_1 U
96 ThrottleNeutralPosition_0_2 U
97 ThrottleNeutralPosition_0_3 U
98 ThrottleNeutralPosition_0_4 U
99 ThrottleNeutralPosition_0_5 U
100 ThrottleNeutralPosition_1_1
101 ThrottleNeutralPosition_1_2
102 ThrottleNeutralPosition_1_3
103 ThrottleNeutralPosition_1_4
104 ThrottleNeutralPosition_1_5
105 ThrottleNeutralPosition_2_1
106 ThrottleNeutralPosition_2_2
107 ThrottleNeutralPosition_2_3
108 ThrottleNeutralPosition_2_4
109 ThrottleNeutralPosition_2_5
110 DBW_DUMMY_WORD21
111 DBW_DUMMY_WORD22
112 DBW_DUMMY_WORD23
113 DBW_DUMMY_WORD24
114 DBW_DUMMY_WORD25
115 DBW_DUMMY_WORD26
116 DBW_DUMMY_WORD27
117 DBW_DUMMY_WORD28
118 DBW_DUMMY_WORD29
119 DBW_DUMMY_WORD30
144 PIT_LIMIT
146 DBW_DUMMY_WORD3
152 DBW_DUMMY_WORD9
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
164 EE_TYRE_CONFIG_1
165 EE_TYRE_CONFIG_2
166 EE_FTYRE1_RADIUS U
167 EE_FTYRE1_C1_C2
168 EE_FTYRE1_C3_C4
169 EE_FTYRE2_RADIUS
170 EE_FTYRE2_C1_C2
171 EE_FTYRE2_C3_C4
172 EE_FTYRE3_RADIUS
173 EE_FTYRE3_C1_C2
174 EE_FTYRE3_C3_C4
175 EE_FTYRE4_RADIUS
176 EE_FTYRE4_C1_C2
177 EE_FTYRE4_C3_C4
178 EE_FTYRE5_RADIUS
179 EE_FTYRE5_C1_C2
180 EE_FTYRE5_C3_C4
181 EE_FTYRE6_RADIUS
182 EE_FTYRE6_C1_C2
183 EE_FTYRE6_C3_C4
184 EE_RTYRE1_RADIUS
185 EE_RTYRE1_C1_C2
186 EE_RTYRE1_C3_C4
187 EE_RTYRE2_RADIUS
188 EE_RTYRE2_C1_C2
189 EE_RTYRE2_C3_C4
190 EE_RTYRE3_RADIUS
191 EE_RTYRE3_C1_C2
192 EE_RTYRE3_C3_C4
193 EE_RTYRE4_RADIUS
194 EE_RTYRE4_C1_C2
195 EE_RTYRE4_C3_C4
196 EE_RTYRE5_RADIUS
197 EE_RTYRE5_C1_C2
198 EE_RTYRE5_C3_C4
199 EE_RTYRE6_RADIUS
200 EE_RTYRE6_C1_C2
201 EE_RTYRE6_C3_C4
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
253 SPEED_ODO_SPEEDSOURCE
254 SPEED_ODO_DUMMY2
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
+ 300 MOTORING_MAP BYTE U A9
`,
  },
  {
    tableType: 61453,
    exportStamp: "202002171428",
    fingerprint: "a9cd4f2a",
    delta: `
1 TH_HIGH_B_H_TEMP
2 TH_LOW_B_L_TEMP
3 TH_LOW_CHGBTEMP
4 TH_HIGH_B_PACK_V
5 TH_LOW_B_PACK_V
9 CELL_UNDER_VOLTAGE
10 CELL_UNDERVOLTAGE_WARNING
11 CELL_OVER_VOLTAGE
12 BATTERY_UNBALANCE_WINDOW
13 BATTERY_TRICKLE_CHG_T
14 SOC_VALIDATION_TH
17 EE_CHRONO_DURATION
18 VSM_DUMMY_WORD4
19 VSM_DUMMY_WORD5
20 VSM_DUMMY_WORD6
21 VSM_DUMMY_WORD7
26 VSM_DUMMY_WORD12
27 VSM_DUMMY_WORD13
34 FAN_DUMMY_WORD1
70 RegenFade_0
71 RegenFade_1
72 RegenFade_2 U
73 RegenFade_3 U
74 RegenFade_4 U
75 RegenFade_5 U
76 RegenFade_6
77 RegenFade_7
78 RegenFade_8
79 RegenFade_9
80 RegenFade_10
81 RegenFade_11
82 RegenFade_12
83 RegenFade_13
84 RegenFade_14
85 RegenFade_15
86 RegenFade_16
87 RegenFade_17 U
88 RegenFade_18 U
89 RegenFade_19
90 RegenFade_20
91 RegenFade_21 U
92 RegenFade_22 U
93 RegenFade_23 U
94 RegenFade_24 U
95 ThrottleNeutralPosition_0_1 U
96 ThrottleNeutralPosition_0_2 U
97 ThrottleNeutralPosition_0_3 U
98 ThrottleNeutralPosition_0_4 U
99 ThrottleNeutralPosition_0_5 U
100 ThrottleNeutralPosition_1_1
101 ThrottleNeutralPosition_1_2
102 ThrottleNeutralPosition_1_3
103 ThrottleNeutralPosition_1_4
104 ThrottleNeutralPosition_1_5
105 ThrottleNeutralPosition_2_1
106 ThrottleNeutralPosition_2_2
107 ThrottleNeutralPosition_2_3
108 ThrottleNeutralPosition_2_4
109 ThrottleNeutralPosition_2_5
110 DBW_DUMMY_WORD21
111 DBW_DUMMY_WORD22
112 DBW_DUMMY_WORD23
113 DBW_DUMMY_WORD24
114 DBW_DUMMY_WORD25
115 DBW_DUMMY_WORD26
116 DBW_DUMMY_WORD27
117 DBW_DUMMY_WORD28
118 DBW_DUMMY_WORD29
119 DBW_DUMMY_WORD30
144 PIT_LIMIT
146 DBW_DUMMY_WORD3
152 RPM_FILTER_WEIGHT
153 DBW_DUMMY_WORD10
154 DBW_DUMMY_WORD11
155 DBW_DUMMY_WORD12
156 DBW_DUMMY_WORD13
157 DBW_DUMMY_WORD14
158 DBW_DUMMY_WORD15
159 DBW_DUMMY_WORD16
160 DBW_DUMMY_WORD17
161 DBW_DUMMY_WORD18
162 DBW_DUMMY_WORD19
163 DBW_DUMMY_WORD20
164 EE_TYRE_CONFIG_1
165 EE_TYRE_CONFIG_2
166 EE_FTYRE1_RADIUS U
167 EE_FTYRE1_C1_C2
168 EE_FTYRE1_C3_C4
169 EE_FTYRE2_RADIUS
170 EE_FTYRE2_C1_C2
171 EE_FTYRE2_C3_C4
172 EE_FTYRE3_RADIUS
173 EE_FTYRE3_C1_C2
174 EE_FTYRE3_C3_C4
175 EE_FTYRE4_RADIUS
176 EE_FTYRE4_C1_C2
177 EE_FTYRE4_C3_C4
178 EE_FTYRE5_RADIUS
179 EE_FTYRE5_C1_C2
180 EE_FTYRE5_C3_C4
181 EE_FTYRE6_RADIUS
182 EE_FTYRE6_C1_C2
183 EE_FTYRE6_C3_C4
184 EE_RTYRE1_RADIUS
185 EE_RTYRE1_C1_C2
186 EE_RTYRE1_C3_C4
187 EE_RTYRE2_RADIUS
188 EE_RTYRE2_C1_C2
189 EE_RTYRE2_C3_C4
190 EE_RTYRE3_RADIUS
191 EE_RTYRE3_C1_C2
192 EE_RTYRE3_C3_C4
193 EE_RTYRE4_RADIUS
194 EE_RTYRE4_C1_C2
195 EE_RTYRE4_C3_C4
196 EE_RTYRE5_RADIUS
197 EE_RTYRE5_C1_C2
198 EE_RTYRE5_C3_C4
199 EE_RTYRE6_RADIUS
200 EE_RTYRE6_C1_C2
201 EE_RTYRE6_C3_C4
222 LIMP_DUMMY_WORD8 S
243 FPOSLIGHTS_MIN_CURR_TH
244 FPOSLIGHTS_MAX_CURR_TH
253 SPEED_ODO_SPEEDSOURCE
254 SPEED_ODO_DUMMY2
260 DC_CHG_COMPLETE_TH
262 TARGET_VOLTAGE
263 DC_OVERSHOOT
264 EVSE_DUMMY_WORD3
`,
  },
];
