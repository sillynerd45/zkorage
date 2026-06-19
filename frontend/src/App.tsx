import { Routes, Route } from "react-router-dom";
import MarketingShell from "./shells/MarketingShell";
import AppShell from "./shells/AppShell";
// public (marketing top-bar)
import Landing from "./pages/marketing/Landing";
import Docs from "./pages/marketing/Docs";
import Verify from "./pages/marketing/Verify";
import Explorer from "./pages/marketing/Explorer";
// app (sidebar)
import Home from "./pages/app/Home";
import Reserves from "./pages/app/Reserves";
import Identity from "./pages/app/Identity";
import Compliance from "./pages/app/Compliance";
import Payroll from "./pages/app/Payroll";
import Fundraise from "./pages/app/Fundraise";
import DataRoomLayout from "./pages/app/dataroom/Layout";
import DataRoomOverview from "./pages/app/dataroom/Overview";
import Eligibility from "./pages/app/dataroom/Eligibility";
import DataroomDemo from "./pages/app/dataroom/Demo";
import DataroomRelease from "./pages/app/dataroom/Release";
import DataroomDisclosure from "./pages/app/dataroom/Disclosure";
import DataroomPolicy from "./pages/app/dataroom/Policy";
import DataroomAnchor from "./pages/app/dataroom/Anchor";
import DataroomAuthenticity from "./pages/app/dataroom/Authenticity";
import DataroomOpenShared from "./pages/app/dataroom/OpenShared";

// One unified app, two shells:
//   PUBLIC  marketing top-bar site at "/"      : Landing, Documentation, Verify, Explorer
//   APP     sidebar app at "/app/*"            : the ZK operations + Data Room
export default function App() {
  return (
    <Routes>
      {/* PUBLIC: marketing shell (top-bar) */}
      <Route element={<MarketingShell />}>
        <Route path="/" element={<Landing />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:section" element={<Docs />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/verify/:issuer" element={<Verify />} />
        <Route path="/explorer" element={<Explorer />} />
        <Route path="*" element={<Landing />} />
      </Route>

      {/* APP: sidebar shell */}
      <Route path="/app" element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="reserves" element={<Reserves />} />
        <Route path="identity" element={<Identity />} />
        <Route path="compliance" element={<Compliance />} />
        <Route path="payroll" element={<Payroll />} />
        <Route path="fundraise" element={<Fundraise />} />
        <Route path="dataroom" element={<DataRoomLayout />}>
          <Route index element={<DataRoomOverview />} />
          <Route path="demo" element={<DataroomDemo />} />
          <Route path="eligibility" element={<Eligibility />} />
          <Route path="access" element={<DataroomOpenShared />} />
          {/* "release" + "policy" are folded into "access" (Open a shared document) in the tab bar, but the
              routes stay so the DR3/DR6 deep-dive pages (and their specs) remain reachable by direct URL. */}
          <Route path="release" element={<DataroomRelease />} />
          <Route path="disclosure" element={<DataroomDisclosure />} />
          <Route path="policy" element={<DataroomPolicy />} />
          {/* "documents" = store + open + browse (the page is still implemented in Anchor.tsx) */}
          <Route path="documents" element={<DataroomAnchor />} />
          <Route path="authenticity" element={<DataroomAuthenticity />} />
        </Route>
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
