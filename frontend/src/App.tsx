import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import MarketingShell from "./shells/MarketingShell";
import AppShell from "./shells/AppShell";
// public (marketing top-bar)
import Landing from "./pages/marketing/Landing";
import Docs from "./pages/marketing/Docs";
import Verify from "./pages/marketing/Verify";
import VerifyBond from "./pages/marketing/VerifyBond";
import Explorer from "./pages/marketing/Explorer";
// app (sidebar)
import Home from "./pages/app/Home";
import Reserves from "./pages/app/Reserves";
import Identity from "./pages/app/Identity";
import Compliance from "./pages/app/Compliance";
import Payroll from "./pages/app/Payroll";
import Fundraise from "./pages/app/Fundraise";
import Contracts from "./pages/app/Contracts";
import DataRoomLayout from "./pages/app/dataroom/Layout";
import DataRoomOverview from "./pages/app/dataroom/Overview";
import Eligibility from "./pages/app/dataroom/Eligibility";
import DataroomDemo from "./pages/app/dataroom/Demo";
import DataroomRelease from "./pages/app/dataroom/Release";
import DataroomDisclosure from "./pages/app/dataroom/Disclosure";
import DataroomPolicy from "./pages/app/dataroom/Policy";
import DataroomAnchor from "./pages/app/dataroom/Anchor";
import DataroomMembership from "./pages/app/dataroom/Membership";
import DataroomDiscover from "./pages/app/dataroom/Discover";
import DataroomAuthenticity from "./pages/app/dataroom/Authenticity";
// The member open now lives under Documents (#open). The old /access route redirects there, preserving ?room=.
function DataroomAccessRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/app/dataroom/documents${search}#open`} replace />;
}
import BondedLayout from "./pages/app/bonded/Layout";
import BondedOverview from "./pages/app/bonded/Overview";
import BondedBalances from "./pages/app/bonded/Balances";
import BondedDeposit from "./pages/app/bonded/Deposit";
import BondedProve from "./pages/app/bonded/Prove";
import BondedTier from "./pages/app/bonded/Tier";
import BondedAccessPage from "./pages/app/bonded/Access";

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
        {/* Static /verify/bond outranks the dynamic /verify/:issuer in React Router v6. */}
        <Route path="/verify/bond" element={<VerifyBond />} />
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
        <Route path="contracts" element={<Contracts />} />
        <Route path="dataroom" element={<DataRoomLayout />}>
          <Route index element={<DataRoomOverview />} />
          <Route path="demo" element={<DataroomDemo />} />
          <Route path="eligibility" element={<Eligibility />} />
          <Route path="access" element={<DataroomAccessRedirect />} />
          {/* "release" + "policy" are folded into the member open in the tab bar, but the routes stay so the
              DR3/DR6 deep-dive pages (and their specs) remain reachable by direct URL. */}
          <Route path="release" element={<DataroomRelease />} />
          <Route path="disclosure" element={<DataroomDisclosure />} />
          <Route path="policy" element={<DataroomPolicy />} />
          {/* "documents" = store + open + browse (the page is still implemented in Anchor.tsx) */}
          <Route path="documents" element={<DataroomAnchor />} />
          <Route path="membership" element={<DataroomMembership />} />
          <Route path="discover" element={<DataroomDiscover />} />
          <Route path="authenticity" element={<DataroomAuthenticity />} />
        </Route>
        <Route path="bonded" element={<BondedLayout />}>
          <Route index element={<BondedOverview />} />
          <Route path="balances" element={<BondedBalances />} />
          <Route path="deposit" element={<BondedDeposit />} />
          <Route path="prove" element={<BondedProve />} />
          <Route path="tier" element={<BondedTier />} />
          <Route path="access" element={<BondedAccessPage />} />
        </Route>
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
