// Energica's own diagnostic-trouble-code table, transcribed from
// `<Energica_Manuals>/2 Technical/CAN & Diagnostics/CANBUS from Type Approval.pdf`
// (EN.H.010134.001.OBD E2110, 24/03/2022, §7.6.2.7.4 "List of all OBD output
// codes and formats used"). Data only — no I/O, no state.
//
// SECOND SOURCE, 2026-08-15 — the manufacturer's service-tool data. The tool
// ships the same table as JSON embedded in its own executable, one
// {id, code, symptom, title} record per fault; the extract and the notes on it
// are kept outside this repo, with the rest of the source material. That is a
// second path to the same data — a shipped binary rather than a PDF read by eye
// — so where the two agree the transcription below is corroborated, not merely
// careful. Against the 2021 extract they share 147 (component, symptom) pairs
// and 144 of those carry an IDENTICAL OBD code; the 2024 extract adds two pairs
// and changes none of those numbers otherwise. The disagreements are argued at
// the entries themselves: (44,0) and (44,2), where the PDF wins on the bike's
// own evidence, and (61,2), where the service-tool data replaced a dual code
// with a single one.
//
// ⚠️ THE TWO SERVICE-TOOL VINTAGES ARE ONE SOURCE, NOT TWO. Both the 2021 tool
// (153 records) and the 2024 tool (155) were extracted; the 2024 table is a
// strict superset with ZERO id or title changes — it only adds (4,5) U0115 and
// (35,2) B1021 "REAR BRAKE PROLONGED PRESSURE FAULT". So the newer tool cannot
// be cited as agreeing with the older one: it is the same file carried forward.
// Where the tool and the PDF conflict, three years of shipping did not settle it.
//
// (35,2) B1021 is deliberately NOT added below: nothing states its MIL, and this
// file's third column is what Energica means by a code on this vehicle, which
// that source does not carry either. It is a real gap, listed here so the next
// reader does not have to re-derive the extract to find it.
//
// Coverage is one-directional once both tool vintages are counted: the PDF has
// nothing the 2024 tool lacks, and the tool carries seven codes the PDF omits —
// 51/0, 52/0, 54/13, 60/0, 63/0, 63/1, all six of which are below, plus (35,2)
// B1021, which is not. "Coverage differs in both directions" was the 2021
// reading and it died with the U0115 retraction above.
//
// ⚠️ MIL IS UNKNOWN FOR THE SIX SERVICE-TOOL-ONLY CODES BELOW, and they carry `null`
// to say so. Only the PDF has a MIL column and it does not list them; the
// service tool's JSON has no MIL field at all, for any code. `false` would have
// been a claim — the dashboard renders it as "warning lamp: no" and sorts the
// code with the harmless ones — so the unknown is in the data rather than in
// this comment, the same way stored-codes.ts nulls a code that is not in the
// table at all.
//
// The table is keyed by TWO columns, not one:
//   • COD.    — the VCU's component number, 1…63 and every one of them used
//   • SYMPTOM — which fault of that component, 0…15
// The OBD column is the translation for a generic scan tool. It is not unique:
// U0182 appears under both component 39 and 40. So (component, symptom) is the
// primary key here.
//
// 154 codes — the union of the two sources, less (35,2) B1021, which the note
// above explains. A code the bike reports that is in neither is reported as
// unrecognised rather than guessed at.

export interface DtcTableEntry {
  /** "COD." column — the VCU's component number. */
  component: number;
  /** "SYMPTOM" column — which fault of that component, 0…15. */
  symptom: number;
  /** "OBD" column. Always a single code — see the (61,2) note for the one that wasn't. */
  obdCode: string;
  /** "DTC NAME" column — the generic OBD name of the code. */
  name: string;
  /** "DESCRIPTION" column — what Energica means by it on this vehicle. */
  description: string;
  /**
   * "MIL" column — 1 ⇒ this code turns the malfunction indicator lamp on, and
   * null ⇒ no source states it. Null rather than false for the same reason
   * stored-codes.ts uses null for a code that isn't in the table at all:
   * rendering an absent MIL column as "warning lamp: no" would be an answer we
   * do not have. Only the six service-tool-only codes are null.
   */
  illuminatesMil: boolean | null;
}

export const DTC_TABLE: DtcTableEntry[] = [
  entry(1, 0, "P0562", "SYSTEM VOLTAGE LOW", "VCU main supply undervoltage", false),
  entry(1, 1, "P0563", "SYSTEM VOLTAGE HIGH", "VCU main supply overvoltage", false),

  entry(2, 0, "U0028", "VEHICLE COMMUNICATION BUS A", "VDB bus off", false),
  entry(2, 1, "U0031", "VEHICLE COMMUNICATION BUS A (LOW)", "VDB bus off uC", false),
  entry(2, 2, "U0034", "VEHICLE COMMUNICATION BUS A (LOW)", "VDB bus off uS", false),

  entry(3, 0, "P1000", "B_PACK_V_LOW", "Battery pack undervoltage", false),
  entry(3, 1, "P1001", "B_PACK_V_HIGH", "Battery pack overvoltage", false),

  entry(4, 0, "P1002", "BTEMP_LOW", "Battery pack under temp", false),
  entry(4, 1, "P1003", "BTEMP_HIGH", "Battery pack over temp", false),
  entry(4, 2, "P0514", "BATTERY TEMPERATURE SENSOR CIRCUIT RANGE/PERFORMANCE", "Error reading temperature", true),
  entry(4, 3, "P0516", "BATTERY TEMPERATURE SENSOR CIRCUIT LOW", "BMS temperature sensor short circuit fault", true),
  entry(4, 4, "P0517", "BATTERY TEMPERATURE SENSOR CIRCUIT HIGH", "BMS temperature sensor open circuit fault", true),
  // KEPT 2026-08-15 as the one entry the 2021 service-tool data had no record
  // of, on the argument that its silence there was a gap rather than evidence.
  // ✅ CONFIRMED 2026-08-16: the 2024 tool carries it, identical id and title.
  // The gap was the older extract's, not the PDF's.
  entry(
    4,
    5,
    "U0115",
    "MISMATCH OF BATTERY CONFIGURATION BETWEEN VCU-BMS",
    "Mismatch of battery configuration between VCU and BMS",
    true
  ),

  entry(
    5,
    0,
    "U0111",
    "LOST COMMUNICATION WITH BATTERY ENERGY CONTROL MODULE 'A'",
    "BMS internal communication problem",
    true
  ),
  entry(
    6,
    0,
    "U0112",
    "LOST COMMUNICATION WITH BATTERY ENERGY CONTROL MODULE 'B'",
    "BMS BCMU-LMU communication problem",
    true
  ),

  entry(7, 0, "P1004", "BMS_CELL_UV", "BMS cell undervoltage alarm", false),
  entry(7, 1, "P1005", "BMS VOLTAGE MISREADING", "Error reading voltage", true),
  entry(7, 2, "P1006", "BMS VOLTAGE MISREADING", "Error reading voltage + BMS cell undervoltage alarm", true),
  entry(7, 3, "P1064", "BMS PACK_VOLTAGE COHERENCY ERROR", "BMS pack voltage coherency error", false),

  entry(8, 0, "P1007", "BMS_CELL_OV", "BMS cell overvoltage alarm", false),
  entry(8, 1, "P1008", "BMS VOLTAGE MISREADING", "BMS misreading voltage", true),
  entry(8, 2, "P1009", "BMS VOLTAGE MISREADING", "BMS misreading voltage + BMS cell overvoltage alarm", true),
  entry(8, 3, "U0113", "BMS DEAD LOCK", "BMS dead lock", false),
  entry(8, 4, "U0114", "BMS COHERENCY ERROR", "BMS coherency error", false),

  entry(9, 0, "U0301", "SOFTWARE INCOMPATIBILITY WITH ECM/PCM", "Drive configuration error", false),

  entry(10, 0, "P1010", "HV+ CONTACTOR SC FAULT", "HV+ contactor short circuit", false),
  entry(10, 1, "P1011", "HV+ CONTACTOR OC FAULT", "HV+ contactor open circuit", false),
  entry(10, 2, "P1012", "HV+ CONTACTOR WELDED", "HV+ contactor welded", false),
  entry(10, 3, "P1013", "HV+ CONTACTOR ERROR", "HV+ contactor error", false),

  entry(11, 0, "P1014", "FCHG CONTACTOR SC FAULT", "Fast-charge contactor short circuit", false),
  entry(11, 1, "P1015", "FCHG CONTACTOR OC FAULT", "Fast-charge contactor open circuit", false),
  entry(11, 2, "P1016", "FCHG CONTACTOR WELDED", "Fast-charge contactor welded circuit", false),
  entry(11, 3, "P1017", "FCHG CONTACTOR ERROR", "Fast-charge contactor error", false),

  entry(12, 0, "P1018", "HV- CONTACTOR SC FAULT", "HV- contactor short circuit", false),
  entry(12, 1, "P1019", "HV- CONTACTOR OC FAULT", "HV- contactor open circuit", false),
  entry(12, 2, "P1020", "HV- CONTACTOR WELDED FAULT", "HV- contactor welded fault", false),
  entry(12, 3, "P1021", "HV- CONTACTOR ERROR", "HV- contactor error", false),

  entry(13, 0, "P1022", "CHG CONTACTOR SC", "Charge contactor short circuit", false),
  entry(13, 1, "P1023", "CHG CONTACTOR OC", "Charge contactor open circuit", false),
  entry(13, 2, "P1024", "CHG CONTACTOR ERROR", "Possible contactor fault", false),

  entry(14, 0, "P1025", "PRECHARGE SEQUENCE", "Precharge sequence failed", false),
  entry(
    14,
    1,
    "P1026",
    "PRECHARGE CONTACTOR SC",
    "Precharge sequence failed — precharge contactor short circuit",
    false
  ),
  entry(
    14,
    2,
    "P1027",
    "PRECHARGE CONTACTOR OC",
    "Precharge sequence failed — precharge contactor open circuit",
    false
  ),

  entry(15, 0, "P0A08", "DC/DC CONVERTER STATUS CIRCUIT", "PSU over maximum temperature", false),

  entry(16, 0, "P0A10", "DC/DC CONVERTER STATUS CIRCUIT HIGH INPUT", "PSU output too high", false),
  entry(16, 1, "P0A09", "DC/DC CONVERTER STATUS CIRCUIT LOW INPUT", "PSU output too low", false),

  entry(17, 0, "P1028", "PSU OVERCURRENT", "12 V circuit abnormal load", false),

  entry(18, 0, "U0037", "VEHICLE COMMUNICATION BUS B", "DTB bus off", false),
  entry(18, 1, "U0040", "VEHICLE COMMUNICATION BUS B (LOW)", "DTB bus off uC", false),
  entry(18, 2, "U0043", "VEHICLE COMMUNICATION BUS B (LOW)", "DTB bus off uS", false),

  entry(
    19,
    0,
    "P0117",
    "ENGINE COOLANT TEMPERATURE CIRCUIT LOW",
    "Motor coolant temperature circuit low (short circuit)",
    true
  ),
  entry(
    19,
    1,
    "P0118",
    "ENGINE COOLANT TEMPERATURE CIRCUIT HIGH",
    "Motor coolant temperature circuit high (open circuit)",
    true
  ),
  entry(19, 2, "P0298", "ENGINE OIL OVER TEMPERATURE", "Motor oil over temperature", true),

  entry(20, 0, "P1049", "DRIVE OVERTEMP", "Drive temperature too high", true),
  entry(20, 1, "U0110", "LOST COMMUNICATION WITH DRIVE MOTOR CONTROL MODULE", "Drive generic error", true),
  entry(
    20,
    2,
    "P0A02",
    "MOTOR ELECTRONICS COOLANT TEMPERATURE SENSOR CIRCUIT LOW",
    "Drive coolant temperature circuit low (short circuit)",
    true
  ),
  entry(
    20,
    3,
    "P0A03",
    "MOTOR ELECTRONICS COOLANT TEMPERATURE SENSOR CIRCUIT HIGH",
    "Drive coolant temperature circuit high (open circuit)",
    true
  ),
  entry(20, 4, "P0335", "CRANKSHAFT POSITION SENSOR 'A' CIRCUIT", "Motor position error", true),

  entry(21, 0, "P1029", "ODOMETER ACCESS ERROR", "Odometer EEPROM read/write failed", false),
  entry(21, 1, "P0632", "ODOMETER NOT PROGRAMMED - ECM/PCM", "Odometer not programmed", false),

  entry(22, 0, "P1030", "VCU CELL UNDERVOLTAGE", "Cell undervoltage VCU alarm", false),

  entry(23, 0, "C1000", "LEAK DETECT", "Leak detected between HV circuit and chassis", false),
  entry(24, 0, "C1001", "HV+ LEAK DETECT", "Leak detected between chassis and HV+ rail", false),
  entry(25, 0, "C1002", "HV- LEAK DETECT", "Leak detected between chassis and HV- rail", false),

  entry(26, 0, "P2503", "CHARGING SYSTEM VOLTAGE LOW", "Charger DC undervoltage shutdown", false),
  entry(26, 1, "P2504", "CHARGING SYSTEM VOLTAGE HIGH", "Charger DC overvoltage shutdown", false),
  entry(26, 2, "P1031", "CHARGER DC CONNECTION", "Charger DC connection failure", false),

  entry(
    27,
    0,
    "P1032",
    "CHARGER CONTROL",
    "Charger control timeout shutdown — no control frame received within 1000 ms",
    false
  ),

  entry(28, 0, "P1033", "CHARGER DC CURRENT LIMIT", "Charger reached DC current limit", false),
  entry(29, 0, "P1034", "CHARGER SCI COMM", "Charger DSP SPI communication error", false),

  entry(30, 0, "P1035", "CHARGER AC OV", "Charger AC overvoltage shutdown", false),
  entry(30, 1, "P1036", "CHARGER AC UV", "Charger AC undervoltage shutdown", false),

  entry(31, 0, "P1037", "CHARGER HIGHTEMP", "Charger high temperature shutdown (primary or secondary)", false),
  entry(31, 1, "P1038", "CHARGER LOWTEMP", "Low temperature shutdown", false),

  entry(32, 0, "P1039", "CHARGER TRANSFORMER FAILURE", "Transformer failure — unable to provide power", false),

  entry(33, 0, "P1040", "CHARGER FAN OC", "Charger fan open circuit fault", false),
  entry(33, 1, "P1041", "CHARGER FAN SC", "Charger fan short circuit fault", false),
  entry(33, 2, "P1042", "CHARGER FAN LOCK", "Charger fan locked", false),

  entry(34, 0, "B1000", "POSITION LIGHTS OC", "Position lights open circuit fault", false),
  entry(34, 1, "B1001", "POSITION LIGHTS SC", "Position lights short circuit fault", false),

  entry(35, 0, "B1002", "STOP LIGHTS OC", "Stop lights open circuit fault", false),
  entry(35, 1, "B1003", "STOP LIGHTS SC", "Stop lights short circuit fault", false),

  entry(36, 0, "B1004", "LEFT INDICATOR OC", "Left indicator open circuit fault", false),
  entry(36, 1, "B1005", "LEFT INDICATOR SC", "Left indicator short circuit fault", false),

  entry(37, 0, "B1006", "RIGHT INDICATOR OC", "Right indicator open circuit fault", false),
  entry(37, 1, "B1007", "RIGHT INDICATOR SC", "Right indicator short circuit fault", false),

  entry(38, 0, "B1008", "INDICATOR CONTROL", "Indicator lights control block fault", false),

  entry(39, 0, "B1009", "LOW BEAM OC", "Low beam open circuit fault", false),
  entry(39, 1, "B1010", "LOW BEAM SC", "Low beam short circuit fault", false),
  entry(39, 2, "B1011", "LOW BEAM UF", "Low beam undefined fault", false),
  entry(
    39,
    3,
    "U0182",
    "LOST COMMUNICATION WITH LIGHTING CONTROL MODULE FRONT",
    "Low beam module communication error — module not responding",
    false
  ),

  entry(40, 0, "B1012", "HIGH BEAM OC", "High beam open circuit fault", false),
  entry(40, 1, "B1013", "HIGH BEAM SC", "High beam short circuit fault", false),
  entry(40, 2, "B1014", "HIGH BEAM UF", "High beam undefined fault", false),
  entry(
    40,
    3,
    "U0182",
    "HIGH BEAM MODULE COMM ERR",
    "High beam module communication error — module not responding",
    false
  ),

  entry(41, 0, "P0120", "THROTTLE/PEDAL POSITION SENSOR/SWITCH 'A' CIRCUIT", "Throttle fault (physical error)", true),
  entry(
    42,
    0,
    "P0121",
    "THROTTLE/PEDAL POSITION SENSOR/SWITCH 'A' CIRCUIT RANGE/PERFORMANCE",
    "Throttle fault (logic error)",
    true
  ),

  entry(43, 0, "B1015", "HORN OC", "Horn open circuit fault", false),
  entry(43, 1, "B1016", "HORN SC", "Horn short circuit fault", false),

  // ⚠️ REVERTED 2026-08-16 — these were swapped on 2026-08-15 and the swap was
  // wrong. The type-approval PDF's original pairing is restored: symptom 0 (open
  // circuit) is P0A07, symptom 2 (locked) is P0A05. THE BIKE ITSELF SETTLES IT,
  // and the evidence was already in this repo.
  //
  // ✅ WHAT THE VCU ACTUALLY TRANSMITS. scripts/captured-dtc-transfer.ts holds a
  // real mode-03 reply, 2026-08-04, byte-identical across five transfers. Its 39
  // two-byte DTCs contain `0A 07` — P0A07 — and NO `0A 05`. This bike's chronic
  // fault is (44,0), the open pump driver: it is the one fault known to be real
  // independently of anything on the bus, it is permanently present, and it is
  // therefore necessarily among the stored codes. Under the swap the stored list
  // claimed a *seized* pump and no open-circuit fault at all, on a bike whose
  // pump is not connected to that driver and so cannot seize. Run
  // `node --experimental-strip-types scripts/decode-dtc-response.ts` to see it.
  //
  // ✅ THE LIST IS IN COMPONENT ORDER, which is a check on the reading rather
  // than an argument for it. The 39 codes walk components 1,3,4,4,5,6,7,10,11,
  // 12,12,16,20,22,34…40,41,42,44,46,48,49,53,53,54×6,56,56,61,62 — strictly
  // ascending, symptoms ascending within a component. P0A07 lands between P0121
  // (42,0) and P1044 (46,0), i.e. in component 44's slot. That is worth nothing
  // as evidence about WHICH symptom, since both readings put the code on
  // component 44; it only confirms the code was read off the right row. Do not
  // stretch it further — the list carries plenty of non-minimal symptoms (P0514
  // is (4,2), P1012 (10,2), P1016 (11,2), P1020 (12,2), P1021 (12,3), P0601
  // (53,4), and the charge-manager block reaches symptom 11), so "symptom 2
  // would be the odd one out" is FALSE and was claimed here once.
  //
  // ❌ WHY THE SAE J2012 ARGUMENT FOR THE SWAP DOES NOT HOLD. It ran: an "open
  // circuit" description under a "CIRCUIT HIGH" name is self-contradictory, so
  // the rows must be swapped. But HIGH ⇒ OPEN and LOW ⇒ SHORT is Energica's
  // convention throughout this very table, and it is the physically right one for
  // a pulled-up driver-diagnostic input — an open circuit floats high, a short to
  // ground reads low. Uncontested examples in this file: (4,3) P0516 "…CIRCUIT
  // LOW" = short circuit against (4,4) P0517 "…CIRCUIT HIGH" = open circuit, and
  // (16,0) P0A10 "…CIRCUIT HIGH INPUT" against (16,1) P0A09 "…LOW INPUT". The
  // type-approval PDF spells it out in the code names themselves: P0117/P0118
  // "COOLANT TEMPERATURE CIRCUIT LOW (SHORT CIRCUIT)" / "HIGH (OPEN CIRCUIT)",
  // and P0A02/P0A03 the same. So P0A07 "CIRCUIT HIGH" = open circuit is the
  // CONSISTENT reading; the premise of the swap was backwards.
  //
  // 🟡 THE SERVICE TOOL STILL SAYS OTHERWISE, in both the 2021 and the 2024
  // build — {P0A05: open, P0A06: short, P0A07: locked} — and that is left
  // recorded rather than explained away. Three things weigh against it: the two
  // builds are one file carried forward, not two witnesses (see the header); the
  // tool is generic across Energica's range while the Ribelle workshop manual
  // p.288 is bike-specific and agrees with the type-approval PDF; and nothing in
  // the tool depends on this string being what the VCU puts on the wire — it
  // looks faults up by (code, symptom) and prints the id, so an id that never
  // matched the transmitted DTC would never misbehave for a technician. That is
  // exactly the kind of field that rots unnoticed.
  //
  // 📌 THE ROW THAT STILL LOOKS WRONG, AND WHY IT ISN'T EVIDENCE. Symptom 2 now
  // reads P0A05 "…CONTROL CIRCUIT/OPEN" against the description "Water pump
  // locked", which is the same shape of mismatch #48 pointed at. Saying so here
  // so round three does not start from it: the `name` column is the code's
  // GENERIC SAE name and `description` is what Energica means by it ON THIS
  // VEHICLE, and those two are allowed to diverge — that is the whole reason the
  // table has both columns. More to the point the mismatch is symmetric and so
  // decides nothing: a locked rotor is not a circuit fault at all, so whichever
  // of the three codes Energica hands it will carry a name that does not fit.
  // Under the 2026-08-15 swap the very same complaint applied to P0A07 "…CIRCUIT
  // HIGH" = "locked". Only symptom 0 has a name that must fit, and it does.
  //
  // ⚠️ SYMPTOM 0 IS THIS BIKE'S OWN FAULT — the coolant pump is wired to the
  // heated-grip output, leaving the VCU's pump driver open. It is P0A07, as older
  // notes here, in obd-garage/, and to other owners have always said. P0A05 on
  // this bike would mean a seized pump.
  entry(44, 0, "P0A07", "MOTOR ELECTRONICS COOLANT PUMP CONTROL CIRCUIT HIGH", "Water pump open circuit fault", false),
  entry(44, 1, "P0A06", "MOTOR ELECTRONICS COOLANT PUMP CONTROL CIRCUIT LOW", "Water pump short circuit fault", false),
  entry(44, 2, "P0A05", "MOTOR ELECTRONICS COOLANT PUMP CONTROL CIRCUIT/OPEN", "Water pump locked", false),

  entry(45, 0, "P1043", "MAIN HV FUSE", "Main fuse blown", false),
  entry(46, 0, "P1044", "VCU CELL OVERVOLTAGE", "Cell overvoltage VCU alarm", true),
  entry(47, 0, "B1017", "PASSING WARNING", "Passing light pressed for more than 60 s", false),
  entry(48, 0, "P1045", "ERROR INLET", "Error inlet", false),
  entry(49, 0, "P1046", "BATTERY PACK UNBALANCED", "Battery pack unbalanced alarm", false),
  entry(50, 0, "P1047", "BATTERY UNDER CHG TEMP", "Battery under charge temperature alarm", false),

  // ADDED 2026-08-15 from the service-tool data; the type-approval PDF has no
  // rows for these. Components 51, 52 and 60 are the battery's three statistics
  // records, and their existence is why this file no longer calls those
  // component numbers unused — it used to, on the strength of the PDF's gap
  // alone. The names are the service tool's own titles: the PDF's "DTC NAME"
  // column is where the terser house names elsewhere in this table come from,
  // and it has nothing to say here.
  // MIL is unknown for all six additions, hence `null` — see the ⚠️ note at the top.
  entry(51, 0, "P1050", "BATTERY STATISTICS INFO1", "Battery statistics info 1", null),
  entry(52, 0, "P1051", "BATTERY STATISTICS INFO2", "Battery statistics info 2", null),

  // Component 53 is the safety micro's own self-check. Every symptom shares the
  // one description "LOW LEVEL SAFETY ERROR"; the detail is in the DTC name.
  entry(53, 0, "U1000", "SPI COMMUNICATION ERROR", "Low level safety error", false),
  entry(53, 1, "P1053", "CONTROL-SAFETY VERSION MISMATCH", "Low level safety error", false),
  entry(53, 2, "P0610", "CONTROL MODULE VEHICLE OPTION ERROR", "Low level safety error (uC parameter error)", false),
  entry(53, 3, "P1054", "SAFETY MODULE VEHICLE OPTION ERROR", "Low level safety error (uS parameter error)", false),
  entry(53, 4, "P0601", "INTERNAL CONTROL MODULE MEMORY CHECK SUM ERROR", "Low level safety error", false),
  entry(53, 5, "P1055", "INTERNAL SAFETY MODULE CHECK SUM ERROR", "Low level safety error", false),
  entry(53, 6, "P1063", "INTERNAL CONTROL MODULE READ ONLY MEMORY ERROR", "Low level safety error", false),
  entry(53, 7, "P1056", "INTERNAL SAFETY MODULE READ ONLY MEMORY ERROR", "Low level safety error", false),
  entry(
    53,
    8,
    "P0603",
    "INTERNAL CONTROL MODULE KEEP ALIVE MEMORY (KAM) ERROR",
    "Low level safety error (watchdog error)",
    false
  ),
  entry(53, 9, "P1057", "MICRO SAFETY RESET BY MICRO CONTROL ERROR", "Low level safety error", false),
  entry(53, 10, "P1058", "MICRO CONTROL RESET BY MICRO SAFETY ERROR", "Low level safety error", false),
  entry(53, 11, "P2641", "TORQUE MANAGEMENT FEEDBACK SIGNAL 'B'", "Low level safety error", true),
  entry(53, 12, "P1059", "KILIS CONTROL EPROM ERROR", "Low level safety error", false),
  entry(53, 13, "P1060", "KILIS SAFETY EPROM ERROR", "Low level safety error", false),
  entry(53, 14, "P1061", "CHECK INFO LIST", "Low level safety error", false),
  entry(53, 15, "P1062", "GENERIC ERRORR", "Low level safety error", false),

  // Component 54 is the charge manager (CM) — the AC/DC charging state machine.
  entry(54, 0, "C1003", "UNSPECIFIED CM ERROR", "Unspecified charge manager error", false),
  entry(54, 1, "C1004", "CP LINE PROBLEM OR EVSE NOT COMPATIBLE", "CP line problem or EVSE not compatible", false),
  entry(54, 2, "C1005", "LOCKING DEVICE PROBLEM", "Locking device problem", false),
  entry(54, 3, "C1006", "CM-VEHICLE COMMUNICATION ERROR", "Charge manager to vehicle communication error", false),
  entry(54, 4, "C1007", "CM INTERNAL ERROR", "Charge manager internal error", false),
  entry(54, 5, "C1008", "EVSE EMERGENCY SHUTDOWN", "EVSE emergency shutdown", false),
  entry(54, 6, "C1009", "QCA ERROR", "QCA (powerline modem) error", false),
  entry(54, 7, "C1010", "PROTOCOL ERROR", "Protocol error", false),
  entry(54, 8, "C1011", "CM APPLICATION LAYER ERROR", "Charge manager application layer error", false),
  entry(54, 9, "C1012", "SLAC PROCES ERROR", "SLAC process error", false),
  entry(54, 10, "C1013", "AC LINE ERROR", "AC line error", false),
  entry(54, 11, "C1014", "UNCLASSIFIED CM ERROR", "Unclassified charge manager error", false),
  entry(54, 12, "C1015", "FAST CHARGE NOT PRESENT", "Fast charge not present", false),
  // Added 2026-08-15 from the service-tool data (see the note at component 51). MIL unknown.
  entry(54, 13, "C1018", "CURRENT SET POINT EXCEEDED BY EVSE", "Current set point exceeded by EVSE", null),

  entry(55, 0, "P2637", "TORQUE MANAGEMENT FEEDBACK SIGNAL 'A'", "Torque feedback error", false),

  entry(56, 0, "C1016", "ASSET", "Asset module — no run", false),
  entry(56, 1, "C1017", "ASSET", "Asset module — run", false),

  entry(57, 0, "B1018", "FLASH FULL", "Low flash storage", false),
  entry(58, 0, "P0605", "INTERNAL CONTROL MODULE READ ONLY MEMORY (ROM) ERROR", "Flash read/write error", false),
  entry(59, 0, "U0412", "INVALID DATA RECEIVED FROM BATTERY ENERGY CONTROL MODULE A", "BMS status error", false),

  // Added 2026-08-15 from the service-tool data (see the note at component 51). MIL unknown.
  entry(60, 0, "P1052", "BATTERY STATISTICS INFO3", "Battery statistics info 3", null),

  entry(61, 0, "P0500", "VEHICLE SPEED SENSOR 'A'", "Front wheel speed sensor failure", false),
  entry(61, 1, "P2158", "VEHICLE SPEED SENSOR 'B'", "Rear wheel speed sensor failure", false),
  // ⚠️ CORRECTED 2026-08-15: this was recorded as the dual code "P2158+P0500",
  // named "VEHICLE SPEED SENSOR 'A' + VEHICLE SPEED SENSOR 'B'". That was a
  // deliberate reading, not a slip — the PDF's cell does appear to name both
  // sensors' codes for the both-failed case, and the interface carried a special
  // note for it. The service-tool data gives one ordinary code instead, C0065,
  // and that wins: it was the only "two codes at once" entry in either source,
  // and a scan tool has one code slot per fault to receive it in, so the dual
  // form could never have been transmitted as written. The name below is the
  // service tool's title, since the PDF's name described the pair rather than
  // C0065.
  entry(
    61,
    2,
    "C0065",
    "FRONT AND REAR WHEEL SPEED SENSORS FAILURE",
    "Front and rear wheel speed sensors failure",
    false
  ),
  entry(61, 3, "P2162", "VEHICLE SPEED SENSOR 'A' / 'B' CORRELATION", "Wheel speed sensor coherency failure", false),

  entry(
    62,
    0,
    "U0121",
    "LOST COMMUNICATION WITH ANTI-LOCK BRAKE SYSTEM (ABS) CONTROL MODULE",
    "ABS timeout communication error",
    false
  ),

  // Added 2026-08-15 from the service-tool data (see the note at component 51). MIL unknown.
  // Component 63 is the rear position lights, and it is the reason the component
  // range above now reads 1…63: the PDF's table stops at 62.
  entry(63, 0, "B1019", "REAR POSITION LIGHTS OPEN CIRCUIT FAULT", "Rear position lights open circuit fault", null),
  entry(63, 1, "B1020", "REAR POSITION LIGHTS SHORT CIRCUIT FAULT", "Rear position lights short circuit fault", null),
];

/** The table entry for a (component, symptom) pair, or null if it isn't listed. */
export function lookupByComponentSymptom(component: number, symptom: number): DtcTableEntry | null {
  return byComponentSymptom.get(component * 16 + symptom) ?? null;
}

/**
 * The table entry for an OBD code such as "P1046", or null. One code appears
 * twice in the table (U0182 under components 39 and 40); the first is returned,
 * so prefer lookupByComponentSymptom whenever the component is known.
 */
export function lookupByObdCode(obdCode: string): DtcTableEntry | null {
  return byObdCode.get(obdCode.toUpperCase()) ?? null;
}

/**
 * Renders a 16-bit binary DTC the way a scan tool does: the top two bits pick
 * the letter (P, C, B, U), the next two are the first digit, and the remaining
 * three nibbles are hex. 0x1046 ⇒ "P1046", 0xC111 ⇒ "U0111".
 */
export function formatObdDtc(value: number): string {
  const letter = "PCBU"[(value >> 14) & 3];
  const firstDigit = (value >> 12) & 3;
  return `${letter}${firstDigit}${((value & 0x0fff) | 0x1000).toString(16).toUpperCase().slice(1)}`;
}

/** A short one-line label for logs and dashboards: "P1046 — Battery pack unbalanced alarm". */
export function describeEntry(tableEntry: DtcTableEntry): string {
  return `${tableEntry.obdCode} — ${tableEntry.description}`;
}

/**
 * The signal key a code is logged under. Keyed on the numeric identity rather
 * than the OBD code because the OBD column is not unique, and because a code we
 * cannot name still needs a stable key.
 */
export function dtcSignalKey(component: number, symptom: number): string {
  return `dtc_${component.toString().padStart(4, "0")}_${symptom}`;
}

function entry(
  component: number,
  symptom: number,
  obdCode: string,
  name: string,
  description: string,
  illuminatesMil: boolean | null
): DtcTableEntry {
  return { component, symptom, obdCode, name, description, illuminatesMil };
}

const byComponentSymptom = new Map<number, DtcTableEntry>(
  DTC_TABLE.map(tableEntry => [tableEntry.component * 16 + tableEntry.symptom, tableEntry])
);

// First one wins: U0182 is listed under both component 39 and 40, and the
// low-beam entry (39) is the one the document lists first.
const byObdCode = new Map<string, DtcTableEntry>();
for (const tableEntry of DTC_TABLE) {
  if (!byObdCode.has(tableEntry.obdCode)) {
    byObdCode.set(tableEntry.obdCode, tableEntry);
  }
}
