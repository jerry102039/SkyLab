import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import MIcon from "../MIcon";
import { useToast } from "../../hooks/useToast";
import { AiPveLogService } from "../../services/aiPveLog";
import styles from "./AiPveChat.module.scss";

/** 清除模型殘留的 tool call 與思考標記，避免原始標記顯示在對話框中。 */
export function sanitizeAiPveContent(value) {
  return String(value ?? "")
    .replace(/<\|?tool_call\|?>[\s\S]*?<\|?\/?tool_call\|?>/g, "")
    .replace(/<\|?tool_call\|?>\s*call:[a-zA-Z0-9_]+\s*\{[\s\S]+\}/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\|[^>]*\|>/g, "")
    .trim();
}

/** 將 AI 回覆以安全的 Markdown 呈現，避免格式標記以原始文字顯示。 */
export function AiPveMarkdownContent({ content }) {
  return (
    <div className={`${styles.msgContent} ${styles.msgMarkdown}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {sanitizeAiPveContent(content)}
      </ReactMarkdown>
    </div>
  );
}

export default function AiPveChat({ initialPrompt = "", compact = false, fill = false }) {
  const { t } = useTranslation("components");
  const toast = useToast();
  const initialPromptRef = useRef(String(initialPrompt ?? "").trim());
  const initialPromptHandledRef = useRef(false);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: t("AiPveChat.introMessage"),
    },
  ]);
  const [chatHistory, setChatHistory] = useState([]);
  const [pendingTool, setPendingTool] = useState(null);
  const [pendingCommand, setPendingCommand] = useState("");
  const logEndRef = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending, pendingTool]);

  const canSend = input.trim().length > 0 && !isSending && !pendingTool;

  function handleChatResponse(response) {
    if (response.error) toast.error(response.error);
    setChatHistory(response.messages || []);
    setMessages((previous) => [
      ...previous,
      {
        role: "assistant",
        content: response.reply || response.error || t("AiPveChat.commandDoneFallback"),
        tools: response.tools_called,
      },
    ]);

    if (response.needs_confirmation) {
      const sshTool = response.tools_called?.find(
        (tool) => tool.name === "ssh_exec" && tool.result?.pending,
      );
      if (sshTool?.result?.confirm_token) {
        const command = sshTool.args?.command || "";
        setPendingTool({
          token: sshTool.result.confirm_token,
          command,
          reason: sshTool.args?.reason || t("AiPveChat.defaultConfirmReason"),
        });
        setPendingCommand(command);
      }
    }
  }

  async function sendMessage(rawMessage) {
    const message = String(rawMessage ?? "").trim();
    if (!message || isSending || pendingTool) return;

    setInput("");
    setIsSending(true);
    setMessages((previous) => [...previous, { role: "user", content: message }]);

    const newHistory = [...chatHistory];
    if (newHistory.length > 0) newHistory.push({ role: "user", content: message });

    try {
      const response = await AiPveLogService.chat(
        newHistory.length > 0 ? { messages: newHistory } : { message },
      );
      handleChatResponse(response);
    } catch (error) {
      const detail = error?.message ?? t("AiPveChat.chatFailedFallback");
      toast.error(detail);
      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: t("AiPveChat.errorOccurred", { detail }) },
      ]);
    } finally {
      setIsSending(false);
    }
  }

  useEffect(() => {
    const prompt = initialPromptRef.current;
    if (!prompt || initialPromptHandledRef.current) return;
    initialPromptHandledRef.current = true;
    sendMessage(prompt);
  }, []);

  function handleSubmit(event) {
    event.preventDefault();
    sendMessage(input);
  }

  async function handleConfirm(approved) {
    if (!pendingTool) return;
    const command = pendingCommand.trim();
    if (approved && !command) {
      toast.error(t("AiPveChat.enterCommandFirst"));
      return;
    }
    setIsSending(true);

    try {
      const result = await AiPveLogService.confirmSsh({
        token: pendingTool.token,
        approved,
        command: approved ? command : undefined,
      });
      const currentToken = pendingTool.token;
      setPendingTool(null);
      setPendingCommand("");

      if (!approved) {
        setMessages((previous) => [
          ...previous,
          { role: "assistant", content: t("AiPveChat.commandCancelled") },
        ]);
        setIsSending(false);
        return;
      }

      const updatedHistory = [...chatHistory];
      const targetIndex = updatedHistory.findIndex(
        (message) => message.role === "tool"
          && typeof message.content === "string"
          && message.content.includes(currentToken),
      );
      if (targetIndex !== -1) {
        updatedHistory[targetIndex] = {
          ...updatedHistory[targetIndex],
          content: JSON.stringify(result),
        };
      }

      const response = await AiPveLogService.chat({ messages: updatedHistory });
      handleChatResponse(response);
    } catch (error) {
      toast.error(error?.message ?? t("AiPveChat.confirmFailed"));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className={`${styles.chatCard} ${compact ? styles.compact : ""} ${fill ? styles.fill : ""}`}>
      <div className={styles.chatLog} aria-live="polite">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`${styles.msg} ${message.role === "user" ? styles.msg_user : styles.msg_assistant}`}
          >
            <div className={styles.msgHead}>
              <MIcon name={message.role === "assistant" ? "smart_toy" : "person"} size={16} />
              <span>{message.role === "assistant" ? "AI-PVE" : t("AiPveChat.you")}</span>
            </div>
            {message.role === "assistant" ? (
              <AiPveMarkdownContent content={message.content} />
            ) : (
              <p className={`${styles.msgContent} ${styles.msgPlain}`}>
                {sanitizeAiPveContent(message.content)}
              </p>
            )}
            {message.tools?.length > 0 && (
              <div className={styles.toolRow}>
                <span className={styles.toolLabel}>
                  <MIcon name="terminal" size={14} />
                  {t("AiPveChat.toolCallsLabel")}
                </span>
                {message.tools.map((tool, toolIndex) => (
                  <span key={`${tool.name}-${toolIndex}`} className={styles.toolBadge}>
                    {tool.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {pendingTool && (
          <div className={styles.pendingBox}>
            <div className={styles.pendingHead}>
              <MIcon name="warning" size={18} />
              {t("AiPveChat.pendingHeading")}
            </div>
            <p className={styles.pendingReason}>
              <strong>{t("AiPveChat.pendingReasonLabel")}</strong>
              {pendingTool.reason}
            </p>
            <textarea
              value={pendingCommand}
              onChange={(event) => setPendingCommand(event.target.value)}
              placeholder={t("AiPveChat.pendingCommandPlaceholder")}
              disabled={isSending}
            />
            <p className={styles.pendingHint}>{t("AiPveChat.pendingHint")}</p>
            <div className={styles.pendingActions}>
              <button
                type="button"
                className={styles.btnAllow}
                onClick={() => handleConfirm(true)}
                disabled={isSending || pendingCommand.trim().length === 0}
              >
                <MIcon name="check" size={16} />
                {t("AiPveChat.allowButton")}
              </button>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => handleConfirm(false)}
                disabled={isSending}
              >
                <MIcon name="close" size={16} />
                {t("AiPveChat.rejectButton")}
              </button>
            </div>
          </div>
        )}

        {isSending && (
          <div className={styles.thinking}>
            <span className={styles.pulse} />
            {t("AiPveChat.thinking")}
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      <form className={styles.composer} onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t("AiPveChat.composerPlaceholder")}
          disabled={isSending || Boolean(pendingTool)}
        />
        <div className={styles.composerActions}>
          <button type="submit" className={styles.btnPrimary} disabled={!canSend}>
            <MIcon name="send" size={16} />
            {t("AiPveChat.sendButton")}
          </button>
        </div>
      </form>
    </div>
  );
}
