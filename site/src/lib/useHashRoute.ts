import { useEffect, useState } from "react";

// 极简 hash 路由（静态托管友好，无依赖）
//   #/                 → { name: "overview" }
//   #/chapter/01       → { name: "chapter", id: "01" }

export type Route =
  | { name: "overview" }
  | { name: "chapter"; id: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const m = h.match(/^\/chapter\/(\w+)/);
  if (m) return { name: "chapter", id: m[1] };
  return { name: "overview" };
}

export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof window !== "undefined" ? window.location.hash : "")
  );

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (r: Route) => {
    const hash =
      r.name === "overview" ? "#/" : `#/chapter/${r.id}`;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      setRoute(r); // 同址也刷新
    }
  };

  return [route, navigate];
}
