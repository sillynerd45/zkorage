import { useEffect, useState } from "react";
import { getDataroomInfo, type DataroomInfoResp } from "@/lib/api";

export function useDataroomInfo() {
  const [info, setInfo] = useState<DataroomInfoResp | null>(null);
  useEffect(() => {
    getDataroomInfo().then(setInfo).catch(() => {});
  }, []);
  return info;
}
