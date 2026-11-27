declare const __T3_CLIENT_PRODUCT_NAME__: string | undefined;

// The fork web bundle supplies its name. Native clients use their shipped product name.
export const clientProductName =
  typeof __T3_CLIENT_PRODUCT_NAME__ === "string" ? __T3_CLIENT_PRODUCT_NAME__ : "T3 Code";
