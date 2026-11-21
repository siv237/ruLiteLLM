import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import LoadingScreen from "./LoadingScreen";

describe("LoadingScreen", () => {
  it("shows the ruLiteLLM brand with the cab logo, not the emoji one", () => {
    render(<LoadingScreen />);
    expect(screen.getByText("ruLiteLLM")).toBeInTheDocument();
    const logo = document.querySelector('img[src*="rulitellm_cab.png"]');
    expect(logo).not.toBeNull();
    expect(screen.queryByText(/🚅/)).not.toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});
