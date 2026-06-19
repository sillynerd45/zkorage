import { Routes, Route, NavLink } from "react-router-dom";
import IssuerDashboard from "./pages/IssuerDashboard";
import IdentityPage from "./pages/IdentityPage";
import CompliancePage from "./pages/CompliancePage";
import PayrollPage from "./pages/PayrollPage";
import FundraisePage from "./pages/FundraisePage";
import DataRoomLayout from "./pages/dataroom/DataRoomLayout";
import OverviewRoute from "./pages/dataroom/OverviewRoute";
import GuidedDemoRoute from "./pages/dataroom/GuidedDemoRoute";
import EligibilityRoute from "./pages/dataroom/EligibilityRoute";
import ReleaseRoute from "./pages/dataroom/ReleaseRoute";
import DisclosureRoute from "./pages/dataroom/DisclosureRoute";
import PolicyRoute from "./pages/dataroom/PolicyRoute";
import AnchorRoute from "./pages/dataroom/AnchorRoute";
import AuthenticityRoute from "./pages/dataroom/AuthenticityRoute";
import VerifyPage from "./pages/VerifyPage";
import ExplorerPage from "./pages/ExplorerPage";
import DeveloperPage from "./pages/DeveloperPage";
import VersionBadge from "./components/VersionBadge";

export default function App() {
  return (
    <div className="wrap">
      <a className="skip-link" href="#main">Skip to main content</a>
      <div className="brand">
        <h1>zkorage<span className="dot">.</span></h1>
        <span className="tag">Prove a private fact — verify it on-chain.</span>
      </div>

      <nav className="topnav" aria-label="Primary">
        <NavLink to="/" end>Issuer</NavLink>
        <NavLink to="/identity">Identity</NavLink>
        <NavLink to="/compliance">Compliance</NavLink>
        <NavLink to="/payroll">Payroll</NavLink>
        <NavLink to="/fundraise">Fundraise</NavLink>
        <NavLink to="/dataroom">Data Room</NavLink>
        <NavLink to="/verify">Verify it yourself</NavLink>
        <NavLink to="/explorer">Explorer</NavLink>
        <NavLink to="/developer">Developer</NavLink>
      </nav>

      <main id="main" tabIndex={-1}>
      <Routes>
        <Route path="/" element={<IssuerDashboard />} />
        <Route path="/identity" element={<IdentityPage />} />
        <Route path="/compliance" element={<CompliancePage />} />
        <Route path="/payroll" element={<PayrollPage />} />
        <Route path="/fundraise" element={<FundraisePage />} />
        <Route path="/dataroom" element={<DataRoomLayout />}>
          <Route index element={<OverviewRoute />} />
          <Route path="demo" element={<GuidedDemoRoute />} />
          <Route path="eligibility" element={<EligibilityRoute />} />
          <Route path="release" element={<ReleaseRoute />} />
          <Route path="disclosure" element={<DisclosureRoute />} />
          <Route path="policy" element={<PolicyRoute />} />
          <Route path="anchor" element={<AnchorRoute />} />
          <Route path="authenticity" element={<AuthenticityRoute />} />
        </Route>
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/verify/:issuer" element={<VerifyPage />} />
        <Route path="/explorer" element={<ExplorerPage />} />
        <Route path="/developer" element={<DeveloperPage />} />
        <Route path="*" element={<IssuerDashboard />} />
      </Routes>
      </main>

      <VersionBadge />
    </div>
  );
}
