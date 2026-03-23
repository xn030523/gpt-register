package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"codex-register/internal/runtime"
	"codex-register/internal/store"
)

func (a *apiServer) handleAccountRoute(w http.ResponseWriter, req *http.Request) {
	path := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/accounts/"), "/")
	if path == "" {
		http.NotFound(w, req)
		return
	}

	parts := strings.Split(path, "/")
	accountID, err := strconv.Atoi(parts[0])
	if err != nil || accountID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid account id"})
		return
	}

	if len(parts) == 1 {
		a.handleAccountDetailByID(w, req, accountID)
		return
	}

	switch parts[1] {
	case "tokens":
		if len(parts) == 2 {
			a.handleAccountTokens(w, req, accountID)
			return
		}
		if len(parts) == 3 && parts[2] == "regenerate-links" {
			a.handleAccountBindCardLinksRegenerate(w, req, accountID)
			return
		}
		http.NotFound(w, req)
	case "refresh":
		a.handleAccountRefresh(w, req, accountID)
	case "validate":
		a.handleAccountValidate(w, req, accountID)
	case "upload-cpa":
		a.handleAccountCPAUpload(w, req, accountID)
	default:
		http.NotFound(w, req)
	}
}

func (a *apiServer) handleAccountDetailByID(w http.ResponseWriter, req *http.Request, accountID int) {
	if req.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	account, err := a.store.GetAccountByID(req.Context(), accountID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if account == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "账号不存在"})
		return
	}
	writeJSON(w, http.StatusOK, account)
}

func (a *apiServer) handleAccountTokens(w http.ResponseWriter, req *http.Request, accountID int) {
	if req.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	account, err := a.store.GetAccountTokensByID(req.Context(), accountID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if account == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "账号不存在"})
		return
	}

	bindCardURL, bindCardLongURL, _ := a.ensureBindCardLinks(req.Context(), accountID, account, false)
	writeAccountTokensResponse(w, account, bindCardURL, bindCardLongURL)
}

func (a *apiServer) handleAccountBindCardLinksRegenerate(w http.ResponseWriter, req *http.Request, accountID int) {
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	account, err := a.store.GetAccountTokensByID(req.Context(), accountID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if account == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "账号不存在"})
		return
	}

	bindCardURL, bindCardLongURL, err := a.ensureBindCardLinks(req.Context(), accountID, account, true)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	writeAccountTokensResponse(w, account, bindCardURL, bindCardLongURL)
}

func (a *apiServer) handleAccountRefresh(w http.ResponseWriter, req *http.Request, accountID int) {
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var payload struct {
		Proxy string `json:"proxy"`
	}
	if req.Body != nil {
		_ = json.NewDecoder(req.Body).Decode(&payload)
	}

	result := runtime.RefreshAccountToken(req.Context(), a.store, accountID, runtime.ResolveProxy(payload.Proxy))
	if result.Success {
		writeJSON(w, http.StatusOK, map[string]any{
			"success":    true,
			"message":    "Token 刷新成功",
			"expires_at": result.ExpiresAt,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": false,
		"error":   result.ErrorMessage,
	})
}

func (a *apiServer) handleBatchRefresh(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var payload struct {
		IDs   []int  `json:"ids"`
		Proxy string `json:"proxy"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	result := map[string]any{
		"success_count": 0,
		"failed_count":  0,
		"errors":        []map[string]any{},
	}

	errorsList := result["errors"].([]map[string]any)
	for _, accountID := range payload.IDs {
		refreshResult := runtime.RefreshAccountToken(req.Context(), a.store, accountID, runtime.ResolveProxy(payload.Proxy))
		if refreshResult.Success {
			result["success_count"] = result["success_count"].(int) + 1
			continue
		}
		result["failed_count"] = result["failed_count"].(int) + 1
		errorsList = append(errorsList, map[string]any{"id": accountID, "error": refreshResult.ErrorMessage})
	}
	result["errors"] = errorsList
	writeJSON(w, http.StatusOK, result)
}

func (a *apiServer) handleAccountValidate(w http.ResponseWriter, req *http.Request, accountID int) {
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var payload struct {
		Proxy string `json:"proxy"`
	}
	if req.Body != nil {
		_ = json.NewDecoder(req.Body).Decode(&payload)
	}

	valid, errText := runtime.ValidateAccountToken(req.Context(), a.store, accountID, runtime.ResolveProxy(payload.Proxy))
	writeJSON(w, http.StatusOK, map[string]any{
		"id":    accountID,
		"valid": valid,
		"error": errText,
	})
}

func (a *apiServer) handleBatchValidate(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var payload struct {
		IDs   []int  `json:"ids"`
		Proxy string `json:"proxy"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	details := make([]map[string]any, 0, len(payload.IDs))
	validCount := 0
	invalidCount := 0
	for _, accountID := range payload.IDs {
		valid, errText := runtime.ValidateAccountToken(req.Context(), a.store, accountID, runtime.ResolveProxy(payload.Proxy))
		if valid {
			validCount++
		} else {
			invalidCount++
		}
		details = append(details, map[string]any{"id": accountID, "valid": valid, "error": errText})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"valid_count":   validCount,
		"invalid_count": invalidCount,
		"details":       details,
	})
}

func (a *apiServer) handleAccountCPAUpload(w http.ResponseWriter, req *http.Request, accountID int) {
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var payload struct {
		Proxy string `json:"proxy"`
	}
	if req.Body != nil {
		_ = json.NewDecoder(req.Body).Decode(&payload)
	}

	cpaConfig := runtime.ResolveCPAConfig(req.Context(), a.store)
	if !cpaConfig.Enabled {
		writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": "CPA 上传未启用"})
		return
	}

	proxyURL := strings.TrimSpace(payload.Proxy)
	if proxyURL == "" {
		proxyURL = cpaConfig.ProxyURL
	} else {
		proxyURL = runtime.ResolveProxy(proxyURL)
	}

	success, message := runtime.UploadAccountToCPA(req.Context(), a.store, accountID, cpaConfig.APIURL, cpaConfig.APIToken, proxyURL)
	if success {
		writeJSON(w, http.StatusOK, map[string]any{"success": true, "message": message})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": false, "error": message})
}

func (a *apiServer) handleBatchCPAUpload(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var payload struct {
		IDs   []int  `json:"ids"`
		Proxy string `json:"proxy"`
	}
	if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	cpaConfig := runtime.ResolveCPAConfig(req.Context(), a.store)
	if !cpaConfig.Enabled {
		writeJSON(w, http.StatusOK, map[string]any{
			"success_count": 0,
			"failed_count":  0,
			"skipped_count": 0,
			"details":       []map[string]any{{"success": false, "error": "CPA 上传未启用"}},
		})
		return
	}
	proxyURL := strings.TrimSpace(payload.Proxy)
	if proxyURL == "" {
		proxyURL = cpaConfig.ProxyURL
	} else {
		proxyURL = runtime.ResolveProxy(proxyURL)
	}

	result := runtime.BatchUploadAccountsToCPA(req.Context(), a.store, payload.IDs, cpaConfig.APIURL, cpaConfig.APIToken, proxyURL)
	writeJSON(w, http.StatusOK, result)
}

func truncateToken(value *string) any {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return truncateValue(trimmed, 50)
}

func writeAccountTokensResponse(w http.ResponseWriter, account *store.AccountTokens, bindCardURL, bindCardLongURL string) {
	writeJSON(w, http.StatusOK, map[string]any{
		"id":                         account.ID,
		"email":                      account.Email,
		"access_token":               pointerValue(account.AccessToken),
		"access_token_summary":       truncateValue(pointerValue(account.AccessToken), 50),
		"refresh_token":              pointerValue(account.RefreshToken),
		"refresh_token_summary":      truncateValue(pointerValue(account.RefreshToken), 50),
		"id_token":                   pointerValue(account.IDToken),
		"id_token_summary":           truncateValue(pointerValue(account.IDToken), 50),
		"bind_card_url":              bindCardURL,
		"bind_card_url_summary":      truncateValue(bindCardURL, 72),
		"bind_card_long_url":         bindCardLongURL,
		"bind_card_long_url_summary": truncateValue(bindCardLongURL, 120),
		"has_tokens":                 account.AccessToken != nil && account.RefreshToken != nil,
	})
}

func (a *apiServer) ensureBindCardLinks(
	ctx context.Context,
	accountID int,
	account *store.AccountTokens,
	force bool,
) (string, string, error) {
	bindCardURL := accountExtraString(account.ExtraData, "bind_card_url")
	bindCardLongURL := accountExtraString(account.ExtraData, "bind_card_long_url")
	if !force && bindCardURL != "" && bindCardLongURL != "" {
		return bindCardURL, bindCardLongURL, nil
	}
	if account.AccessToken == nil {
		return bindCardURL, bindCardLongURL, nil
	}

	links, err := runtime.GenerateBindCardLinks(ctx, *account.AccessToken, pointerValue(account.ProxyUsed))
	if err != nil {
		return bindCardURL, bindCardLongURL, err
	}

	if force || bindCardURL == "" {
		bindCardURL = strings.TrimSpace(links.ShortURL)
	}
	if force || bindCardLongURL == "" {
		bindCardLongURL = strings.TrimSpace(links.LongURL)
	}

	mergedExtra := cloneExtraData(account.ExtraData)
	if bindCardURL != "" {
		mergedExtra["bind_card_url"] = bindCardURL
		mergedExtra["bind_card_url_summary"] = summarizeValue(bindCardURL, 88)
	}
	if bindCardLongURL != "" {
		mergedExtra["bind_card_long_url"] = bindCardLongURL
		mergedExtra["bind_card_long_url_summary"] = summarizeValue(bindCardLongURL, 140)
	}
	if len(mergedExtra) > 0 {
		if updateErr := a.store.UpdateAccount(ctx, accountID, map[string]any{"extra_data": mergedExtra}); updateErr == nil {
			account.ExtraData = mergedExtra
		}
	}

	return bindCardURL, bindCardLongURL, nil
}

func truncateValue(value string, keep int) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if keep < 16 {
		keep = 16
	}
	if len(trimmed) <= keep {
		return trimmed
	}
	return trimmed[:keep] + "..."
}

func summarizeValue(value string, keep int) string {
	summary, _ := truncateValue(value, keep).(string)
	return summary
}

func accountExtraString(extra map[string]any, key string) string {
	if len(extra) == 0 {
		return ""
	}
	value, _ := extra[key].(string)
	return strings.TrimSpace(value)
}

func cloneExtraData(extra map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range extra {
		result[key] = value
	}
	return result
}

func pointerValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}
