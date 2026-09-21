import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangePasswordModal } from "../src/App";
const html = renderToStaticMarkup(createElement(ChangePasswordModal, {
  value: { currentPassword: "", password: "", confirmation: "" },
  error: undefined, busy: false, onChange: () => {}, onClose: () => {}, onSubmit: () => {},
}));
console.log(html.slice(0, 400));
