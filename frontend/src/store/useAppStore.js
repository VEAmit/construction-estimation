import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_MEASURE_LABEL_SIZE } from '../utils/measureLabel'

export const useAppStore = create(
  persist(
    (set, get) => ({
      // ── Hydration flag (not persisted) ────────────────────
      // True once the persist middleware has finished loading from localStorage.
      // ProtectedRoute must wait for this before checking the token, or it will
      // flash the login page on every page load while the store re-hydrates.
      _hydrated: false,
      _setHydrated: () => set({ _hydrated: true }),

      // ── Auth ──────────────────────────────────────────────
      token: null,
      userEmail: null,
      userName: null,
      userRole: null,
      setAuth: (token, email, name, role) => {
        set({ token, userEmail: email, userName: name, userRole: role })
      },
      clearAuth: () => {
        set({ token: null, userEmail: null, userName: null, userRole: null })
      },
      isAuthenticated: () => !!get().token,

      // ── Projects ──────────────────────────────────────────
      projects: [],
      selectedProject: null,
      setProjects: (projects) => set({ projects }),
      setSelectedProject: (project) => set({ selectedProject: project }),

      // ── Drawings ──────────────────────────────────────────
      drawings: [],
      selectedDrawing: null,
      setDrawings: (drawings) =>
        set((s) => ({
          drawings:
            typeof drawings === 'function'
              ? drawings(Array.isArray(s.drawings) ? s.drawings : [])
              : drawings,
        })),
      setSelectedDrawing: (drawing) => set({ selectedDrawing: drawing }),
      updateDrawingCalibration: (id, scaleRatio, unit) =>
        set((s) => {
          const list = Array.isArray(s.drawings) ? s.drawings : []
          const patch = { scaleRatio, calibrationUnit: unit, isCalibrated: true }
          return {
            drawings: list.map((d) => (d.id === id ? { ...d, ...patch } : d)),
            selectedDrawing:
              s.selectedDrawing?.id === id
                ? { ...s.selectedDrawing, ...patch }
                : s.selectedDrawing,
          }
        }),

      // ── Measurements (Takeoff) ────────────────────────────
      takeoffItems: [],
      summary: null,
      setTakeoffItems: (items) => set({ takeoffItems: items }),
      addTakeoffItem: (item) => set((s) => ({ takeoffItems: [...s.takeoffItems, item] })),
      updateTakeoffItem: (item) =>
        set((s) => ({ takeoffItems: s.takeoffItems.map((t) => (t.id === item.id ? item : t)) })),
      removeTakeoffItem: (id) =>
        set((s) => ({ takeoffItems: s.takeoffItems.filter((t) => t.id !== id) })),
      setSummary: (summary) => set({ summary }),

      // ── Member Schedule ───────────────────────────────────
      memberScheduleItems: [],
      memberScheduleSummary: null,
      setMemberScheduleItems: (items) => set({ memberScheduleItems: items }),
      addMemberScheduleItem: (item) =>
        set((s) => ({ memberScheduleItems: [...s.memberScheduleItems, item] })),
      updateMemberScheduleItem: (item) =>
        set((s) => ({
          memberScheduleItems: s.memberScheduleItems.map((m) => (m.id === item.id ? item : m)),
        })),
      removeMemberScheduleItem: (id) =>
        set((s) => ({ memberScheduleItems: s.memberScheduleItems.filter((m) => m.id !== id) })),
      setMemberScheduleSummary: (summary) => set({ memberScheduleSummary: summary }),

      // ── Bluebeam-style: selected member for linked measurements ──
      selectedMemberScheduleItem: null,
      lastMeasureMember: null,
      setSelectedMemberScheduleItem: (item) => set((s) => ({
        selectedMemberScheduleItem: item,
        lastMeasureMember: item ?? s.lastMeasureMember,
        ...(item?.memberType ? { measureCategory: item.memberType } : {}),
        activeUnit: 'Mm',
        ...(item?.color ? { measureColor: item.color } : {}),
      })),
      clearSelectedMemberScheduleItem: () => set({ selectedMemberScheduleItem: null, lastMeasureMember: null }),
      // Return to the neutral workspace without changing saved measurements.
      resetDrawingInteraction: () => set({
        activeTool: 'select',
        selectedMemberScheduleItem: null,
        lastMeasureMember: null,
        pasteAnchor: null,
      }),

      // ── Tool state ────────────────────────────────────────
      activeTool: 'select',
      activeUnit: 'Mm',
      measureColor:    '#EF233C',
      measureCategory: 'General',
      lineThickness:   2,
      fillOpacity:     0.3,
      lineStyle:       'solid',   // 'solid' | 'dashed' | 'dotted'
      arrowStyle:      'none',    // 'none' | 'start' | 'end' | 'both'
      linearLineMode:  'simple',  // 'simple' | 'arrow' — Bluebeam-style plain vs arrow line
      fontSize:        14,        // font size (pt) for the Text annotation tool
      measureLabelFontSize: DEFAULT_MEASURE_LABEL_SIZE, // label size for line/area/perimeter (pt)
      // Global show/hide for measurement labels on the PDF (Bluebeam-style
      // declutter toggle) — never touches the underlying measurements or the
      // grid, purely a rendering preference. The currently selected
      // measurement's label stays visible even while hidden, so the user can
      // still see what they're editing.
      showMeasurementLabels: true,
      // Endpoint snapping is enabled by default to preserve the established
      // drawing behaviour. The toolbar toggle only changes whether the
      // existing snap resolver participates in point placement.
      snapEnabled: true,
      countSession:    0,         // running count of markers in current session
      pdfScale: 1.2,
      pdfPage: 1,
      pdfTotalPages: 1,
      wheelZoomSensitivity: 1, // multiplier on mouse-wheel zoom speed — 0.5 (slow) .. 2 (fast)
      // Held-Space pan override, tracked by PdfJsViewer's keydown/keyup listeners.
      // Line/Calibrate use left-drag to draw, so a plain left-drag meant only as
      // a pan (e.g. repositioning the view right after upload, when Calibrate is
      // auto-armed) would otherwise be captured as a draw gesture and commit a
      // stray line + calibration popup. Holding Space lets it pan instead,
      // regardless of which tool is active.
      spaceHeld: false,
      setSpaceHeld: (held) => set({ spaceHeld: held }),
      // Entering Calibrate still starts with a clean slate — clear any member
      // left selected from an earlier Linear session so a stale selection
      // can't silently attach to a calibration line the user never meant to
      // link. But MemberSchedulePanel's handleSelectMember can DELIBERATELY
      // set a member while already in Calibrate mode (it calls
      // setSelectedMemberScheduleItem directly, not setActiveTool, so it
      // isn't cleared here) — that's how one line can both set the new scale
      // AND save as that member's measurement.
      setActiveTool:     (tool)  => set({
        activeTool: tool,
        ...(tool === 'calibrate' ? { selectedMemberScheduleItem: null, lastMeasureMember: null } : {}),
      }),
      setActiveUnit:     (unit)  => set({ activeUnit: unit }),
      setMeasureColor:   (color) => set({ measureColor: color }),
      setMeasureCategory:(cat)   => set({ measureCategory: cat }),
      setLineThickness:  (t)     => set({ lineThickness: t }),
      setFillOpacity:    (o)     => set({ fillOpacity: o }),
      setLineStyle:      (s)     => set({ lineStyle: s }),
      setArrowStyle:     (s)     => set({ arrowStyle: s }),
      setLinearLineMode: (m)     => set({ linearLineMode: m }),
      setFontSize:       (s)     => set({ fontSize: s }),
      setMeasureLabelFontSize: (s) => set({ measureLabelFontSize: s }),
      setShowMeasurementLabels: (v) => set({ showMeasurementLabels: v }),
      toggleShowMeasurementLabels: () => set((s) => ({ showMeasurementLabels: !s.showMeasurementLabels })),
      setSnapEnabled: (v) => set({ snapEnabled: Boolean(v) }),
      toggleSnapEnabled: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
      setCountSession:   (n)     => set({ countSession: n }),
      setPdfScale: (scaleFn) =>
        set((s) => ({ pdfScale: typeof scaleFn === 'function' ? scaleFn(s.pdfScale) : scaleFn })),
      setPdfPage: (pageFn) =>
        set((s) => ({ pdfPage: typeof pageFn === 'function' ? pageFn(s.pdfPage) : pageFn })),
      setPdfTotalPages: (total) => set({ pdfTotalPages: total }),
      setWheelZoomSensitivity: (v) => set({ wheelZoomSensitivity: Math.min(2, Math.max(0.5, Number(v) || 1)) }),

      // ── Imperative viewer commands ────────────────────────
      pdfCommand: null,
      triggerPdfCommand: (cmd) => set({ pdfCommand: cmd }),
      clearPdfCommand:   ()    => set({ pdfCommand: null }),

      // ── Measurement clipboard (session-only, not persisted) ──
      measurementClipboard: null,
      setMeasurementClipboard: (data) => set({ measurementClipboard: data }),
      clearMeasurementClipboard: () => set({ measurementClipboard: null }),

      /** PDF point where the user clicked before paste (copy → click → Ctrl+V). */
      pasteAnchor: null,
      setPasteAnchor: (anchor) => set({ pasteAnchor: anchor }),
      clearPasteAnchor: () => set({ pasteAnchor: null }),

      // ── UI ────────────────────────────────────────────────
      isSidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ isSidebarCollapsed: !s.isSidebarCollapsed })),
    }),
    {
      name: 'buildtakeoff-store',
      partialize: (s) => ({
        token: s.token,
        userEmail: s.userEmail,
        userName: s.userName,
        userRole: s.userRole,
        activeUnit: s.activeUnit,
        measureLabelFontSize: s.measureLabelFontSize,
        showMeasurementLabels: s.showMeasurementLabels,
        snapEnabled: s.snapEnabled,
        selectedProject: s.selectedProject,
        wheelZoomSensitivity: s.wheelZoomSensitivity,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state._setHydrated()
      },
    }
  )
)
