import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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
      setDrawings: (drawings) => set({ drawings }),
      setSelectedDrawing: (drawing) => set({ selectedDrawing: drawing }),
      updateDrawingCalibration: (id, scaleRatio, unit) =>
        set((s) => ({
          drawings: s.drawings.map((d) =>
            d.id === id ? { ...d, scaleRatio, calibrationUnit: unit, isCalibrated: true } : d
          ),
          selectedDrawing:
            s.selectedDrawing?.id === id
              ? { ...s.selectedDrawing, scaleRatio, calibrationUnit: unit, isCalibrated: true }
              : s.selectedDrawing,
        })),

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

      // ── Tool state ────────────────────────────────────────
      activeTool: 'select',
      activeUnit: 'Mm',
      measureColor:    '#EF233C',
      measureCategory: 'General',
      lineThickness:   2,
      fillOpacity:     0.3,
      lineStyle:       'solid',   // 'solid' | 'dashed' | 'dotted'
      arrowStyle:      'none',    // 'none' | 'start' | 'end' | 'both'
      fontSize:        14,        // font size (pt) for the Text annotation tool
      countSession:    0,         // running count of markers in current session
      pdfScale: 1.2,
      pdfPage: 1,
      pdfTotalPages: 1,
      setActiveTool:     (tool)  => set({ activeTool: tool }),
      setActiveUnit:     (unit)  => set({ activeUnit: unit }),
      setMeasureColor:   (color) => set({ measureColor: color }),
      setMeasureCategory:(cat)   => set({ measureCategory: cat }),
      setLineThickness:  (t)     => set({ lineThickness: t }),
      setFillOpacity:    (o)     => set({ fillOpacity: o }),
      setLineStyle:      (s)     => set({ lineStyle: s }),
      setArrowStyle:     (s)     => set({ arrowStyle: s }),
      setFontSize:       (s)     => set({ fontSize: s }),
      setCountSession:   (n)     => set({ countSession: n }),
      setPdfScale: (scaleFn) =>
        set((s) => ({ pdfScale: typeof scaleFn === 'function' ? scaleFn(s.pdfScale) : scaleFn })),
      setPdfPage: (pageFn) =>
        set((s) => ({ pdfPage: typeof pageFn === 'function' ? pageFn(s.pdfPage) : pageFn })),
      setPdfTotalPages: (total) => set({ pdfTotalPages: total }),

      // ── Imperative viewer commands ────────────────────────
      pdfCommand: null,
      triggerPdfCommand: (cmd) => set({ pdfCommand: cmd }),
      clearPdfCommand:   ()    => set({ pdfCommand: null }),

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
        selectedProject: s.selectedProject,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) state._setHydrated()
      },
    }
  )
)
